/* engine.js — 낭비 계산기 v1 코어 (브라우저/Node 겸용, 의존성 0)
 *
 * parse_bill.py의 Cost Explorer 경로 축소 이식.
 * 원칙 동일: 집계는 코드가, 판정은 룰이. 원본에 없는 값은 만들지 않는다.
 * 탑재 룰: 확정(BILL) 6개만 — 1(유휴IP)·6(NAT)·9(구세대)·12(gp2)·17(S3수명주기)·25(약정0).
 * 보수 계수: 성적표·블로그에 이미 공개된 값만 사용(구세대 20%, gp3 20%, SP 60%×27%).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WasteEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var AWS_INSTANCE_RE = /\b([a-z]{1,3})(\d)([a-z]*)\.(\w+)/;
  var GPU_FAMILIES = ["p2", "p3", "p4", "p5", "g3", "g4", "g5", "g6", "inf", "trn", "dl1"];

  function money(x) {
    var v = parseFloat(String(x == null ? "" : x).replace(/,/g, "").trim() || "0");
    return isNaN(v) ? 0 : v;
  }

  // 최소 CSV 파서 (따옴표 필드 지원)
  function parseCSV(text) {
    var rows = [], row = [], cur = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cur += ch;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function detectCE(header) {
    var n = 0;
    for (var i = 0; i < header.length; i++) if (header[i].trim().slice(-3) === "($)") n++;
    return n >= 2;
  }

  function flagInstance(itype) {
    var f = { old: false, gpu: false };
    var m = AWS_INSTANCE_RE.exec(itype + ".");
    if (m) {
      var fam = m[1], gen = parseInt(m[2], 10);
      f.old = gen <= 4;
      f.gpu = GPU_FAMILIES.indexOf(fam + gen) >= 0 || fam === "inf" || fam === "trn";
    }
    return f;
  }

  function detectPartnerAzure(header) {
    var hs = header.map(function (h) { return h.replace(/^﻿/, "").trim(); });
    return hs.indexOf("ServiceName") >= 0 && hs.indexOf("BillingAmount") >= 0;
  }

  var AZURE_VER_RE = /_?v(\d)\b/i;
  function flagAzureVM(meter) {
    var f = { old: false, gpu: false };
    if (/\bN[CDV]/i.test(meter)) f.gpu = true;
    var m = AZURE_VER_RE.exec(meter);
    if (m) f.old = parseInt(m[1], 10) <= 3 && !f.gpu;
    return f;
  }

  var NONPROD_RE = /dev|develop|stg|stag|test|qa|sandbox|demo/i;
  var NONPROD_247_HOURS = 650; // 룰10 판정선: 월 650시간 이상 = 밤·주말에도 가동

  function normMonth(s) {
    var m = /(\d{4})[.\-\/](\d{1,2})/.exec(s || "");
    return m ? m[1] + "-" + ("0" + m[2]).slice(-2) : null;
  }

  // ── 파트너사(리셀러) Azure 정산 CSV — 두 변형 지원 ──
  //  간이형: ServiceCategory,ServiceName,ResourceName(=미터),Quantity,Unit,BillingAmount — 날짜 없음
  //  상세형: +ChargeStartDate,ResourceGroup,SUK(SKU),UsedCost — 날짜·리소스그룹·SKU 있음
  function aggregatePartnerAzure(rows, header) {
    var hs = header.map(function (h) { return h.replace(/^﻿/, "").trim(); });
    var col = function (n) { return hs.indexOf(n); };
    var iSvc = col("ServiceName"), iRes = col("ResourceName"), iSku = col("SUK"),
        iQty = col("Quantity"), iUnit = col("Unit"), iAmt = col("BillingAmount"),
        iDate = col("ChargeStartDate"), iRg = col("ResourceGroup");
    var detailed = iSku >= 0;
    var agg = {
      provider: "azure_partner", currency: "KRW", rows: 0, gross: 0, months: {},
      services: {}, usage_types: {},
      net: { nat_hours: 0, nat_bytes: 0, eip_idle: 0 },
      st: { gp2: 0, gp3: 0, s3_std: 0, s3_ia: 0, s3_glacier: 0, s3_int: 0, s3_req: 0,
            blob_hot: 0, blob_cool: 0, blob_archive: 0 },
      instance_cost: {}, old_gen_cost: 0,
      compute_ondemand: 0, sp_ri_signal: false, nonprod_247_cost: 0, nonprod_247: [],
      period: { start: null, end: null }, n_months: 1,
    };
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.length < 2) continue;
      var svc = (row[iSvc] || "").trim();
      // 미터: 상세형은 SKU 우선(B1s, F2s v2 …), 간이형은 ResourceName이 곧 미터
      var meter = detailed ? ((row[iSku] || "").trim() || (row[iRes] || "").trim())
                           : (row[iRes] || "").trim();
      var cost = money(row[iAmt]);
      if (!svc && !meter) continue;
      agg.rows++; agg.gross += cost;
      var mon = iDate >= 0 ? normMonth(row[iDate]) : null;
      if (mon) {
        agg.months[mon] = (agg.months[mon] || 0) + cost;
        if (!agg.period.start || mon < agg.period.start) agg.period.start = mon;
        if (!agg.period.end || mon > agg.period.end) agg.period.end = mon;
      }
      agg.services[svc] = (agg.services[svc] || 0) + cost;
      agg.usage_types[meter] = (agg.usage_types[meter] || 0) + cost;
      var lsvc = svc.toLowerCase(), lm = meter.toLowerCase();

      if (/reserv|savings/i.test(svc + " " + meter)) agg.sp_ri_signal = true;

      if (lsvc.indexOf("virtual machines") >= 0) {
        agg.instance_cost[meter] = (agg.instance_cost[meter] || 0) + cost;
        agg.compute_ondemand += cost;
        // 룰10: 비프로덕션 리소스그룹 + 월 650시간 이상 가동 (행 = 리소스×월)
        if (iRg >= 0 && iQty >= 0 && /hour/i.test(row[iUnit] || "")) {
          var rg = (row[iRg] || "");
          var hrs = money(row[iQty]);
          if (NONPROD_RE.test(rg) && hrs >= NONPROD_247_HOURS) {
            agg.nonprod_247_cost += cost;
            var rname = (row[iRes] || meter).trim();
            if (agg.nonprod_247.indexOf(rname) < 0) agg.nonprod_247.push(rname);
          }
        }
      }
      if (lsvc.indexOf("nat gateway") >= 0 || lm.indexOf("nat gateway") >= 0) {
        if (lm.indexOf("data processed") >= 0 || lm.indexOf("bytes") >= 0) agg.net.nat_bytes += cost;
        else agg.net.nat_hours += cost;
      }
      if (lsvc.indexOf("storage") >= 0 || lsvc.indexOf("blob") >= 0) {
        if (lm.indexOf("hot") >= 0) agg.st.blob_hot += cost;
        else if (lm.indexOf("cool") >= 0 || lm.indexOf("cold") >= 0) agg.st.blob_cool += cost;
        else if (lm.indexOf("archive") >= 0) agg.st.blob_archive += cost;
      }
    }
    var mk = Object.keys(agg.months);
    agg.n_months = Math.max(mk.length, 1);
    if (!agg.period.start) { agg.period.start = "단일 월 파일"; agg.period.end = "날짜 열 없음"; }
    agg.monthly_avg = agg.gross / agg.n_months;
    for (var t in agg.instance_cost) {
      if (flagAzureVM(t).old) agg.old_gen_cost += agg.instance_cost[t];
    }
    return agg;
  }

  // ── 집계 (parse_bill.py read_cost_explorer + _classify 대응 부분) ──
  function aggregate(text) {
    var rows = parseCSV(text);
    if (!rows.length) throw new Error("빈 파일");
    var header = rows[0];
    if (detectPartnerAzure(header)) return aggregatePartnerAzure(rows, header);
    if (!detectCE(header)) {
      throw new Error("지원 포맷이 아닙니다. 지원: ① AWS Cost Explorer CSV(그룹화 기준 '사용 유형') " +
        "② Azure 파트너사 정산 CSV(ServiceName·BillingAmount 열). " +
        "CUR·Azure 표준 Export는 무료 성적표 신청으로 보내주시면 정밀 진단해 드립니다.");
    }
    var cols = [];
    for (var i = 0; i < header.length; i++) {
      var h = header[i].trim();
      if (h.slice(-3) !== "($)") continue;
      var name = h.slice(0, -3).trim();
      var flat = name.replace(/ /g, "");
      if (/^total/i.test(name) || flat === "총비용" || flat === "총계" || flat === "합계") continue;
      cols.push([i, name]);
    }
    var agg = {
      provider: "aws", currency: "USD",
      rows: 0, gross: 0, months: {}, usage_types: {}, services: {},
      net: { nat_hours: 0, nat_bytes: 0, eip_idle: 0 },
      st: { gp2: 0, gp3: 0, s3_std: 0, s3_ia: 0, s3_glacier: 0, s3_int: 0, s3_req: 0 },
      instance_cost: {}, old_gen_cost: 0,
      compute_ondemand: 0, sp_ri_signal: false,
      period: { start: null, end: null },
    };
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row[0]) continue;
      var first = row[0].trim();
      if (/^total/i.test(first) || /합계$/.test(first.replace(/ /g, ""))) continue;
      var date = first.slice(0, 10);
      if (!/^\d{4}-\d{2}/.test(date)) continue;
      if (!agg.period.start || date < agg.period.start) agg.period.start = date;
      if (!agg.period.end || date > agg.period.end) agg.period.end = date;
      for (var c = 0; c < cols.length; c++) {
        var idx = cols[c][0], name = cols[c][1];
        var cost = idx < row.length ? money(row[idx]) : 0;
        if (cost === 0) continue;
        agg.rows++;
        agg.gross += cost;
        var mon = date.slice(0, 7);
        agg.months[mon] = (agg.months[mon] || 0) + cost;

        var looksUT = /[:]|-Bytes|Usage|Requests|ByteHrs|Hours|Address/.test(name);
        if (looksUT) agg.usage_types[name] = (agg.usage_types[name] || 0) + cost;
        else agg.services[name] = (agg.services[name] || 0) + cost;

        var lut = (looksUT ? name : "").toLowerCase();
        var lall = name.toLowerCase();

        // 컴퓨트
        var m = AWS_INSTANCE_RE.exec(lut);
        var isBox = lut.indexOf("boxusage") >= 0 || lut.indexOf("spotusage") >= 0;
        if (m && isBox) {
          var itype = m[1] + m[2] + m[3] + "." + m[4];
          agg.instance_cost[itype] = (agg.instance_cost[itype] || 0) + cost;
        }
        if (isBox && lut.indexOf("spotusage") < 0) agg.compute_ondemand += cost;

        // 약정 신호 (usage_type·서비스명 어느 쪽이든)
        if (/savingsplan|reserved|ri[- ]?fee|heavyusage/.test(lall)) agg.sp_ri_signal = true;

        // 스토리지
        if (lut.indexOf("ebs:volumeusage.gp2") >= 0 || lut.indexOf("volumeusage.gp2") >= 0) agg.st.gp2 += cost;
        else if (lut.indexOf("volumeusage.gp3") >= 0) agg.st.gp3 += cost;
        if (lut.indexOf("timedstorage-byteh") >= 0 && lut.indexOf("sia") < 0 &&
            lut.indexOf("glacier") < 0 && lut.indexOf("int") < 0) agg.st.s3_std += cost;
        else if (lut.indexOf("sia") >= 0 || lut.indexOf("zia") >= 0) agg.st.s3_ia += cost;
        else if (lut.indexOf("glacier") >= 0 || lut.indexOf("gda") >= 0 || lut.indexOf("gir") >= 0) agg.st.s3_glacier += cost;
        else if (lut.indexOf("-int-") >= 0 || lut.indexOf("int") === 0) agg.st.s3_int += cost;
        else if (/requests-tier/i.test(lut) || (lut.indexOf("requests") >= 0 && lall.indexOf("s3") >= 0)) agg.st.s3_req += cost;

        // 네트워크
        if (lut.indexOf("natgateway-hours") >= 0) agg.net.nat_hours += cost;
        if (lut.indexOf("natgateway-bytes") >= 0) agg.net.nat_bytes += cost;
        if (lut.indexOf("idleaddress") >= 0) agg.net.eip_idle += cost;
      }
    }
    var monthKeys = Object.keys(agg.months);
    agg.n_months = Math.max(monthKeys.length, 1);
    agg.monthly_avg = agg.gross / agg.n_months;
    for (var it2 in agg.instance_cost) {
      if (flagInstance(it2).old && !flagInstance(it2).gpu) agg.old_gen_cost += agg.instance_cost[it2];
    }
    return agg;
  }

  // ── 룰 6개 (확정만, 프로바이더 인식) ──
  function applyRules(agg) {
    var n = agg.n_months;
    var per = function (v) { return v / n; }; // 월 환산
    var az = agg.provider === "azure_partner";
    var cur = agg.currency === "KRW"
      ? function (v) { return "₩" + Math.round(v).toLocaleString(); }
      : function (v) { return "$" + v.toFixed(2); };
    var findings = [];

    // 1. 미사용 공인 IP (AWS만 — Azure 청구는 유휴/사용 미구분이라 이 파일로 판정 불가)
    if (agg.net.eip_idle > 0) {
      findings.push({
        rule: 1, title: "미사용 공인 IP (IdleAddress)",
        evidence: "기간 내 IdleAddress 과금 " + cur(agg.net.eip_idle),
        saving: per(agg.net.eip_idle),
        action: "어느 리소스에도 연결되지 않은 공인 IP — 반납 시 서비스 영향 없이 즉시 절감.",
      });
    }
    // 6. 트래픽 없는 NAT (양 클라우드 공통 — 시간요금 대비 처리량 비율)
    if (agg.net.nat_hours > 0 && agg.net.nat_bytes < agg.net.nat_hours * 0.02) {
      findings.push({
        rule: 6, title: "트래픽 없는 NAT 게이트웨이",
        evidence: "시간요금 " + cur(agg.net.nat_hours) + " 대비 데이터 처리 " +
          cur(agg.net.nat_bytes) + " (" + (100 * agg.net.nat_bytes / agg.net.nat_hours).toFixed(2) + "%)",
        saving: per(agg.net.nat_hours),
        action: "라우팅/서브넷 참조 확인 후 삭제. 삭제 전 고정 IP 화이트리스트 여부 확인.",
      });
    }
    // 9. 구세대 인스턴스/VM
    if (agg.old_gen_cost > 0) {
      var oldList = Object.keys(agg.instance_cost).filter(function (t) {
        return az ? flagAzureVM(t).old : flagInstance(t).old;
      });
      findings.push({
        rule: 9, title: az ? "구세대 VM (v3 이하)" : "구세대 인스턴스 (4세대 이하)",
        evidence: "구세대 컴퓨트 " + cur(agg.old_gen_cost) + " (" + oldList.join(", ") + ")",
        saving: per(agg.old_gen_cost) * 0.20,
        action: "최신 세대 전환 시 가격·성능 기준 20% 절감(공개 계수 15~40%의 하한측). 재시작 창만 확보.",
      });
    }
    // 12. gp2 잔존 (AWS만)
    if (agg.st.gp2 > 0) {
      findings.push({
        rule: 12, title: "gp2 볼륨 잔존 (gp3 미전환)",
        evidence: "gp2 " + cur(agg.st.gp2) + (agg.st.gp3 ? " / gp3 " + cur(agg.st.gp3) : " (gp3 사용 없음)"),
        saving: per(agg.st.gp2) * 0.20,
        action: "무중단 전환 — 콘솔에서 볼륨 유형만 변경. 1TB 이상 볼륨은 IOPS 확인 후.",
      });
    }
    // 17. 스토리지 수명주기 부재 (금액 단정 안 함 — 신호만)
    if (agg.st.s3_std > 0 && agg.st.s3_ia + agg.st.s3_glacier + agg.st.s3_int === 0) {
      findings.push({
        rule: 17, title: "S3 수명주기 정책 부재",
        evidence: "표준 티어 " + cur(agg.st.s3_std) + " — IA/Glacier/Intelligent-Tiering 사용 0",
        saving: null,
        action: "90일 미접근 데이터부터 하위 티어로. 절감액은 접근 패턴에 따라 달라져 여기선 단정하지 않는다.",
      });
    }
    if (az && agg.st.blob_hot > 0 && agg.st.blob_cool + agg.st.blob_archive === 0) {
      findings.push({
        rule: 17, title: "Blob 스토리지 계층화 부재",
        evidence: "Hot 티어 " + cur(agg.st.blob_hot) + " — Cool/Archive 사용 0",
        saving: null,
        action: "접근 빈도 낮은 데이터부터 Cool/Archive로. 절감액은 접근 패턴에 따라 달라져 단정하지 않는다.",
      });
    }
    // 10. 비프로덕션 24×7 가동 (Azure 상세형 — 리소스그룹명 + 월 가동시간으로 확정)
    if (az && agg.nonprod_247_cost > 0) {
      findings.push({
        rule: 10, title: "비프로덕션 환경 24×7 가동",
        evidence: "dev/staging 리소스그룹의 VM이 월 650시간 이상 가동 — " + cur(agg.nonprod_247_cost) +
          " (" + agg.nonprod_247.slice(0, 3).join(", ") + (agg.nonprod_247.length > 3 ? " 외" : "") + ")",
        saving: per(agg.nonprod_247_cost) * 0.5,
        action: "평일 주간 자동 시작·중지 스케줄만 걸어도 절반이 사라진다(공개 기준). 야간·주말 자동 중지부터.",
      });
    }
    // 25. 약정 커버리지 0 — AWS는 공개 계수로 하한 산정, Azure는 신호만(공개 계수 없음)
    if (!agg.sp_ri_signal && agg.compute_ondemand > 0) {
      findings.push({
        rule: 25, title: az ? "예약(RI)/Savings Plan 항목 없음" : "Savings Plan / RI 커버리지 0%",
        evidence: (az ? "VM 사용 " : "온디맨드 컴퓨트 ") + cur(agg.compute_ondemand) + " — 약정 관련 항목 없음",
        saving: az ? null : per(agg.compute_ondemand) * 0.60 * 0.27,
        action: az
          ? "상시 가동 VM에 1년 예약을 걸면 확정 절감 — 할인율은 VM 시리즈별로 달라 여기선 단정하지 않는다."
          : "직전 3개월 최저 사용선의 60%에 1년 무선결제 약정(할인 27% 가정) — 인프라 무변경, 결제 조건만.",
      });
    }

    // ── 맛보기 신호 (추정 룰 — 금액 단정 없이 "감지됨"만) ──
    var signals = [];
    var utSum = function (pat) {
      var s = 0;
      for (var k in agg.usage_types) if (pat.test(k)) s += agg.usage_types[k];
      return s;
    };
    if (!az) {
      var lbHours = utSum(/LoadBalancerUsage/i), lcu = utSum(/LCUUsage/i);
      if (lbHours > 0 && lcu < lbHours * 0.1) {
        signals.push({ rule: 5, title: "유휴 로드밸런서 의심",
          evidence: "LB 시간요금 " + cur(lbHours) + " 대비 처리량(LCU) " + cur(lcu) + " — 트래픽이 거의 없다는 신호" });
      }
      var dtOut = utSum(/DataTransfer-Out-Bytes/i);
      if (dtOut > agg.gross * 0.05) {
        signals.push({ rule: 23, title: "인터넷 아웃바운드 과다 의심",
          evidence: "전송(아웃) " + cur(dtOut) + " — 총비의 " + (100 * dtOut / agg.gross).toFixed(1) + "% (경보선 5%)" });
      }
      if (agg.st.s3_req > 0 && agg.st.s3_std > 0 && agg.st.s3_req > agg.st.s3_std * 0.3) {
        signals.push({ rule: 24, title: "S3 요청 비용 이상 의심",
          evidence: "요청비 " + cur(agg.st.s3_req) + " — 스토리지비의 " + (agg.st.s3_req / agg.st.s3_std).toFixed(1) + "배 (경보선 0.3배)" });
      }
      var snap = utSum(/SnapshotUsage/i);
      if (snap > 0) {
        signals.push({ rule: 3, title: "스냅샷 누적 점검 대상",
          evidence: "스냅샷 과금 " + cur(snap) + " — 월별 증가 추세·수명주기 정책 여부는 성적표에서 판정" });
      }
    }

    var confirmed = 0;
    findings.forEach(function (f) { if (f.saving) confirmed += f.saving; });
    var wastePct = agg.monthly_avg > 0 ? (100 * confirmed / agg.monthly_avg) : 0;
    var grade = wastePct < 10 ? "A" : wastePct < 18 ? "B" : wastePct < 27 ? "C" : wastePct < 36 ? "D" : "F";

    return {
      currency: agg.currency || "USD",
      findings: findings,
      signals: signals,
      monthly_confirmed_saving: confirmed,
      monthly_avg: agg.monthly_avg,
      n_months: agg.n_months,
      period: agg.period,
      waste_pct: wastePct,
      preview_grade: grade + "*",
      note: "확정(BILL) 6개 항목만 반영한 하한값. 추정·정밀진단 25개 항목은 미포함 — 실제 낭비는 이보다 크면 컸지 작지 않다.",
    };
  }

  return { parseCSV: parseCSV, aggregate: aggregate, applyRules: applyRules, money: money };
});
