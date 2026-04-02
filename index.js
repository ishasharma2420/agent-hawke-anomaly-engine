import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Allow iframe embedding
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

// CORS — Allow Custom Menu Web / external UIs to call this
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const { LS_ACCESS_KEY, LS_SECRET_KEY, OPENAI_API_KEY, MAVIS_API_KEY } =
  process.env;

// Strip trailing slash
const LS_BASE_URL = (process.env.LS_BASE_URL || "").replace(/\/+$/, "");

// Mavis config
const MAVIS_BASE_URL =
  "https://mavis-rest-us11.leadsquared.com/api/db20260218124424340/tab20260218124438825";
const MAVIS_ORG_CODE = "78807";

// Basic Auth for Mavis (username = accessKey, password = secretKey)
const MAVIS_BASIC_AUTH = Buffer.from(
  `${LS_ACCESS_KEY}:${LS_SECRET_KEY}`
).toString("base64");

/* ================================
   CONFIG
================================ */

const LEAD_TYPE_STUDENT = "OT_2";

const TARGET_STAGES = [
  "Engagement Initiated",
  "Application Pending",
  "Application Completed",
];

const HIGH_INTENT_SOURCES = [
  "B2B Referral",
  "Website",
  "Chatbot",
  "Inbound Phone Call",
  "Pay per Click Ads",
];

const ADVISOR_KEYWORDS = [
  "Inbound Phone Call Activity",
  "Outbound Phone Call Activity",
  "Invorto Call Qualification",
  "Meeting",
  "Flostack Appointment",
];

const ENGAGEMENT_KEYWORDS = [
  "Email Opened",
  "Email Link Clicked",
  "Dynamic Form Submission",
  "Inbound Phone Call Activity",
  "Outbound Phone Call Activity",
  "Logged into Portal",
  "Logged out of Portal",
  "Flostack Appointment",
  "Invorto Call Qualification",
  "Meeting",
];

const AI_DECISION_EVENT_CODE = 211;

/* ================================
   HELPERS
================================ */

function daysBetween(dateString) {
  if (!dateString) return 0;
  const today = new Date();
  const past = new Date(dateString);
  return Math.floor((today - past) / (1000 * 60 * 60 * 24));
}

function flattenLead(lead) {
  const props = {};
  if (lead.LeadPropertyList) {
    lead.LeadPropertyList.forEach((p) => {
      props[p.Attribute] = p.Value;
    });
  }
  return { ...lead, ...props };
}

/* ================================
   MAVIS — BULK FETCH ALL SIS ROWS
================================ */

async function fetchAllSISRecords() {
  try {
    const response = await axios.post(
      `${MAVIS_BASE_URL}/rows/query?orgcode=${MAVIS_ORG_CODE}`,
      {},
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": MAVIS_API_KEY,
          Authorization: `Basic ${MAVIS_BASIC_AUTH}`,
        },
      }
    );

    const rows = response.data?.Data || [];
    console.log(`📊 Mavis: fetched ${rows.length} SIS records`);

    // Build lookup map: prospect_id → SIS record
    const sisMap = {};
    for (const row of rows) {
      if (row.prospect_id) {
        sisMap[row.prospect_id] = row;
      }
    }

    return sisMap;
  } catch (err) {
    console.error(
      "❌ Mavis fetch failed:",
      err.response?.data || err.message
    );
    return {};
  }
}

/* ================================
   CRM — FETCH STUDENT LEADS BY STAGE
================================ */

async function fetchStudentsByStage(stage) {
  const response = await axios.post(
    `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
    {
      Parameter: {
        LookupName: "ProspectStage",
        LookupValue: stage,
        SqlOperator: "=",
      },
      Columns: {
        Include_CSV: [
          "ProspectID",
          "FirstName",
          "LastName",
          "EmailAddress",
          "ProspectStage",
          "LeadType",
          "Source",
          "Phone",
          "CreatedOn",
          "ModifiedOn",
          "Score",
          "EngagementScore",
          "mx_Stage_Entered_On",
          "mx_Offer_Given_Date",
        ].join(","),
      },
      Sorting: { ColumnName: "ModifiedOn", Direction: "1" },
      Paging: { PageIndex: 1, PageSize: 200 },
    },
    {
      params: { accessKey: LS_ACCESS_KEY, secretKey: LS_SECRET_KEY },
      headers: { "Content-Type": "application/json" },
    }
  );

  const rawLeads = Array.isArray(response.data)
    ? response.data
    : response.data?.Leads || [];
  const allFlattened = rawLeads.map(flattenLead);
  const students = allFlattened.filter(
    (l) => l.LeadType === LEAD_TYPE_STUDENT
  );

  console.log(
    `Stage "${stage}": ${rawLeads.length} total, ${students.length} students`
  );
  return students;
}

/* ================================
   CRM — FETCH ACTIVITIES
================================ */

async function fetchActivities(leadId) {
  try {
    const response = await axios.post(
      `${LS_BASE_URL}/ProspectActivity.svc/Retrieve`,
      { Parameter: {}, Paging: { Offset: "0", RowCount: "50" } },
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY,
          leadId,
        },
        headers: { "Content-Type": "application/json" },
      }
    );
    return response.data?.ProspectActivities || [];
  } catch (err) {
    console.error(
      `Failed to fetch activities for ${leadId}:`,
      err.response?.data || err.message
    );
    return [];
  }
}

/* ================================
   CRM — UPDATE LEAD + LOG ACTIVITY
================================ */

async function updateLead(leadId, anomaly) {
  try {
    await axios.post(
      `${LS_BASE_URL}/LeadManagement.svc/Lead.Update`,
      [
        { Attribute: "mx_AI_Anomaly_Status", Value: "Active" },
        { Attribute: "mx_Latest_Anomaly_Type", Value: anomaly.type },
        { Attribute: "mx_Latest_Anomaly_Severity", Value: anomaly.severity },
        {
          Attribute: "mx_Latest_Anomaly_Confidence",
          Value: String(anomaly.confidence || 90),
        },
        {
          Attribute: "mx_Latest_Anomaly_Explanation",
          Value: anomaly.explanation,
        },
        {
          Attribute: "mx_Last_Intelligence_Run",
          Value: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      ],
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY,
          leadId,
        },
        headers: { "Content-Type": "application/json" },
      }
    );
    console.log(`✅ Lead updated: ${leadId} → ${anomaly.type}`);
  } catch (err) {
    console.error(
      `❌ Failed to update lead ${leadId}:`,
      err.response?.data || err.message
    );
  }
}

async function logAIDecision(leadId, anomaly) {
  try {
    await axios.post(
      `${LS_BASE_URL}/ProspectActivity.svc/Create`,
      {
        RelatedProspectId: leadId,
        ActivityEvent: AI_DECISION_EVENT_CODE,
        ActivityNote: `Agent Hawke: ${anomaly.type} (${anomaly.severity})`,
        ActivityDateTime: new Date()
          .toISOString()
          .replace("T", " ")
          .slice(0, 19),
        Fields: [
          { SchemaName: "mx_Custom_1", Value: anomaly.type },
          { SchemaName: "mx_Custom_2", Value: anomaly.severity },
          { SchemaName: "mx_Custom_3", Value: anomaly.explanation },
          { SchemaName: "mx_Custom_4", Value: "Agent Hawke" },
        ],
      },
      {
        params: { accessKey: LS_ACCESS_KEY, secretKey: LS_SECRET_KEY },
        headers: { "Content-Type": "application/json" },
      }
    );
    console.log(`✅ Activity logged: ${leadId} → ${anomaly.type}`);
  } catch (err) {
    console.error(
      `❌ Failed to log activity for ${leadId}:`,
      err.response?.data || err.message
    );
  }
}

/* ================================
   MERGE CRM + SIS DATA
================================ */

function mergeCRMandSIS(lead, sisRecord) {
  return {
    prospectId: lead.ProspectID,
    name: `${lead.FirstName || ""} ${lead.LastName || ""}`.trim(),
    email: lead.EmailAddress || null,
    crmStage: (lead.ProspectStage || "").trim(),
    crmSource: (lead.Source || "").trim(),
    stageEnteredOn: lead.mx_Stage_Entered_On,
    offerGivenDate: lead.mx_Offer_Given_Date,
    daysInStage: daysBetween(lead.mx_Stage_Entered_On),
    offerAge: daysBetween(lead.mx_Offer_Given_Date),

    // SIS fields
    hasSIS: !!sisRecord,
    studentId: sisRecord?.student_id || null,
    enrollmentStatus: sisRecord?.enrollment_status || null,
    admitTerm: sisRecord?.admit_term || null,
    currentTerm: sisRecord?.current_term || null,
    academicStanding: sisRecord?.academic_standing || null,
    creditsEarned: sisRecord?.credits_earned ?? null,
    expectedGraduation: sisRecord?.expected_graduation_date || null,
    tuitionBalance: parseFloat(sisRecord?.tuition_balance || 0),
    financialAidStatus: sisRecord?.financial_aid_status || null,
    scholarshipAmount: parseFloat(sisRecord?.scholarship_amount || 0),
    sisLastUpdated: sisRecord?.last_updated_timestamp || null,
  };
}

/* ================================
   CRM ANOMALY RULES (existing 4)
================================ */

async function detectCRMAnomalies(merged) {
  const { crmStage, crmSource, daysInStage, offerAge, offerGivenDate } =
    merged;

  // 1️⃣ OFFER STALLED
  if (offerGivenDate && crmStage !== "Enrolled" && offerAge > 14) {
    return {
      type: "Offer Stalled",
      severity: "High",
      confidence: 90,
      source: "CRM",
      explanation: `Offer given ${offerAge} days ago but student not enrolled.`,
    };
  }

  // 2️⃣ APPLICATION COMPLETED – NO ADVISOR FOLLOW-UP
  if (crmStage === "Application Completed" && daysInStage > 5) {
    const activities = await fetchActivities(merged.prospectId);
    const hasAdvisor = activities.some((a) => {
      const eventName = a.EventName || "";
      return ADVISOR_KEYWORDS.some((kw) => eventName.includes(kw));
    });
    if (!hasAdvisor) {
      return {
        type: "Application Completed – No Advisor Follow-up",
        severity: "High",
        confidence: 88,
        source: "CRM",
        explanation: `No advisor activity ${daysInStage} days after application completion.`,
      };
    }
  }

  // 3️⃣ APPLICATION PENDING – STALLED
  if (crmStage === "Application Pending" && daysInStage > 7) {
    const activities = await fetchActivities(merged.prospectId);
    const hasEngagement = activities.some((a) => {
      const eventName = a.EventName || "";
      return ENGAGEMENT_KEYWORDS.some((kw) => eventName.includes(kw));
    });
    if (!hasEngagement) {
      return {
        type: "Application Pending – Stalled",
        severity: "Medium",
        confidence: 85,
        source: "CRM",
        explanation: `No engagement activity ${daysInStage} days in Application Pending.`,
      };
    }
  }

  // 4️⃣ HIGH INTENT – NO MOVEMENT
  if (
    crmStage === "Engagement Initiated" &&
    HIGH_INTENT_SOURCES.includes(crmSource) &&
    daysInStage > 7
  ) {
    return {
      type: "High Intent – No Movement",
      severity: "Medium",
      confidence: 82,
      source: "CRM",
      explanation: `High intent source but no stage movement for ${daysInStage} days.`,
    };
  }

  return null;
}

/* ================================
   SIS ANOMALY RULES (new 4)
================================ */

function detectSISAnomalies(merged) {
  if (!merged.hasSIS) return null;

  const activeCRMStages = [
    "Engagement Initiated",
    "Application Pending",
    "Application Completed",
    "Enrolled",
  ];

  // 5️⃣ ENROLLMENT STATUS MISMATCH — Withdrawn
  if (
    merged.enrollmentStatus === "Withdrawn" &&
    activeCRMStages.includes(merged.crmStage)
  ) {
    return {
      type: "Enrollment Status Mismatch",
      severity: "Critical",
      confidence: 95,
      source: "SIS",
      explanation: `SIS shows Withdrawn but CRM stage is "${merged.crmStage}". Immediate CRM update needed.`,
    };
  }

  // 6️⃣ ENROLLMENT STATUS MISMATCH — Admitted but CRM not advanced
  if (
    merged.studentId &&
    (merged.enrollmentStatus === "Active" ||
      merged.enrollmentStatus === "Admitted") &&
    merged.crmStage === "Application Completed"
  ) {
    return {
      type: "Enrollment Status Mismatch – Admitted",
      severity: "High",
      confidence: 92,
      source: "SIS",
      explanation: `SIS has student ID ${merged.studentId} and status "${merged.enrollmentStatus}" but CRM is still at Application Completed.`,
    };
  }

  // 7️⃣ HIGH TUITION BALANCE
  if (
    (merged.enrollmentStatus === "Enrolled" ||
      merged.enrollmentStatus === "Active") &&
    merged.tuitionBalance > 3000
  ) {
    const aidContext =
      merged.financialAidStatus === "Denied"
        ? "Critical"
        : merged.tuitionBalance > 5000
          ? "High"
          : "Medium";
    return {
      type: "High Tuition Balance",
      severity: aidContext,
      confidence: 88,
      source: "SIS",
      explanation: `$${merged.tuitionBalance.toFixed(2)} balance. Aid status: ${merged.financialAidStatus}. Scholarship: $${merged.scholarshipAmount.toFixed(2)}.`,
    };
  }

  // 8️⃣ ACADEMIC PROBATION
  if (
    merged.academicStanding === "Probation" ||
    merged.academicStanding === "Suspension"
  ) {
    return {
      type: `Academic ${merged.academicStanding}`,
      severity: merged.academicStanding === "Suspension" ? "Critical" : "High",
      confidence: 85,
      source: "SIS",
      explanation: `Student on ${merged.academicStanding} with ${merged.creditsEarned} credits earned. Elevated withdrawal and R2T4 return risk.`,
    };
  }

  // 9️⃣ ZERO PROGRESS
  if (
    merged.enrollmentStatus === "Enrolled" &&
    merged.creditsEarned === 0 &&
    merged.currentTerm
  ) {
    return {
      type: "Zero Progress – Active Student",
      severity: "High",
      confidence: 87,
      source: "SIS",
      explanation: `Enrolled for ${merged.currentTerm} but 0 credits earned. May have stopped attending — R2T4 return risk.`,
    };
  }

  // 🔟 ATTENDANCE RISK – POTENTIAL WITHDRAWAL
  if (
    merged.hasSIS &&
    (merged.enrollmentStatus === "Active" || merged.enrollmentStatus === "Enrolled") &&
    merged.academicStanding &&
    merged.academicStanding !== "Good" &&
    merged.creditsEarned !== null &&
    merged.currentTerm
  ) {
    // Student is active but academic standing is not Good and credits are behind
    const standingLabel = merged.academicStanding;
    return {
      type: "Attendance Risk – Potential Withdrawal",
      severity: standingLabel === "Probation" ? "High" : "Critical",
      confidence: 84,
      source: "SIS",
      explanation: `Active student with ${standingLabel} standing and ${merged.creditsEarned} credits earned in ${merged.currentTerm}. Attendance pattern suggests withdrawal risk — triggers R2T4 return exposure.`,
    };
  }

  return null;
}

/* ================================
   OPENAI — ROOT CAUSE ANALYSIS
================================ */

async function analyzeWithOpenAI(anomalies, summary) {
  if (!OPENAI_API_KEY || anomalies.length === 0) return null;

  const prompt = `You are Agent Hawke, an AI anomaly detection system for a for-profit career school admissions CRM.

IMPORTANT CONTEXT — Use this vocabulary and framing in ALL outputs:
- The institution is a for-profit career school (vocational/trade programs: healthcare training, skilled trades, beauty/cosmetology, IT, automotive, culinary).
- "Starts" are the primary revenue metric — a start is a student physically seated on day one of their cohort. The gap between enrolled and started is where revenue disappears.
- Retention is the single largest revenue problem. When a student withdraws mid-program, the school must perform an R2T4 calculation and return Title IV financial aid to the federal government.
- Attendance decline is the leading indicator of withdrawal, followed by GPA decline and missed financial aid disbursements.
- Use "advisors" (never "counselors"). Use "starts" and "start rate" (not just "enrollments"). Use "program completion" (not "graduation" unless referring to a ceremony).
- Cost-per-start, stitch-in (placing a student into a later cohort after missing their original start date), and cancellations are key operational terms.

Here is today's scan summary:
- Total students scanned: ${summary.totalScanned}
- Total anomalies detected: ${anomalies.length}
- Critical: ${anomalies.filter((a) => a.severity === "Critical").length}
- High: ${anomalies.filter((a) => a.severity === "High").length}
- Medium: ${anomalies.filter((a) => a.severity === "Medium").length}

Anomalies detected:
${anomalies
  .map(
    (a, i) =>
      `${i + 1}. [${a.severity}] ${a.type} — ${a.name} (${a.crmStage}): ${a.explanation}`
  )
  .join("\n")}

Respond ONLY with valid JSON (no markdown, no backticks). Use this exact structure:
{
  "rootCauses": [
    {
      "cause": "Short description using career school terminology",
      "confidence": 78,
      "category": "Primary driver | Contributing factor | Minor factor",
      "affectedCount": 3
    }
  ],
  "recommendations": [
    {
      "action": "What to do — use advisor, start rate, and retention language",
      "impact": "Expected outcome framed in starts, retention, or R2T4 risk reduction",
      "priority": "Immediate | This week | This month",
      "effort": "Low | Medium | High"
    }
  ],
  "riskSummary": "One paragraph executive summary of the overall risk posture, framed around start rate protection, retention risk, and R2T4 financial exposure"
}`;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const text = response.data.choices?.[0]?.message?.content || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("❌ OpenAI analysis failed:", err.message);
    return null;
  }
}

/* ================================
   HEALTH CHECK
================================ */

app.get("/", (req, res) => {
  res.send("Agent Hawke v2 is live 🦅 — CRM + SIS + AI");
});

/* ================================
   MAIN ENGINE — /run-intelligence
================================ */

app.post("/run-intelligence", async (req, res) => {
  try {
    const startTime = Date.now();

    // --- Step 1: Fetch all SIS records from Mavis (bulk) ---
    console.log("🔄 Step 1: Fetching SIS data from Mavis...");
    const sisMap = await fetchAllSISRecords();

    // --- Step 2: Fetch student leads from CRM ---
    console.log("🔄 Step 2: Fetching student leads from CRM...");
    let allStudents = [];
    for (const stage of TARGET_STAGES) {
      const students = await fetchStudentsByStage(stage);
      allStudents.push(...students);
    }
    console.log(`Total student leads: ${allStudents.length}`);

    if (allStudents.length === 0) {
      return res.json({
        message: "Hawke scanned — no student leads found",
        total_leads_scanned: 0,
        anomalies_detected: 0,
      });
    }

    // --- Step 3: Merge + Detect anomalies ---
    console.log("🔄 Step 3: Running anomaly detection...");
    const anomalies = [];

    for (const lead of allStudents) {
      const sisRecord = sisMap[lead.ProspectID] || null;
      const merged = mergeCRMandSIS(lead, sisRecord);

      const leadBase = {
        leadId: lead.ProspectID,
        name: merged.name,
        email: merged.email,
        crmStage: merged.crmStage,
        crmSource: merged.crmSource,
        daysInStage: merged.daysInStage,
        hasSIS: merged.hasSIS,
        enrollmentStatus: merged.enrollmentStatus,
        academicStanding: merged.academicStanding,
        tuitionBalance: merged.tuitionBalance,
      };

      // Run BOTH rule sets — a lead can have CRM + SIS anomalies
      const crmAnomaly = await detectCRMAnomalies(merged);
      const sisAnomaly = detectSISAnomalies(merged);

      // Pick the highest severity for CRM write-back
      const primaryAnomaly = sisAnomaly && 
        (sisAnomaly.severity === "Critical" || 
         (sisAnomaly.severity === "High" && crmAnomaly?.severity !== "Critical"))
        ? sisAnomaly : (crmAnomaly || sisAnomaly);

      if (primaryAnomaly) {
        await updateLead(lead.ProspectID, primaryAnomaly);
        await logAIDecision(lead.ProspectID, primaryAnomaly);
      }

      if (crmAnomaly) {
        console.log(`🚨 CRM: ${merged.name} → ${crmAnomaly.type}`);
        anomalies.push({ ...leadBase, ...crmAnomaly });
      }

      if (sisAnomaly) {
        console.log(`🚨 SIS: ${merged.name} → ${sisAnomaly.type}`);
        anomalies.push({ ...leadBase, ...sisAnomaly });
      }
    }

    // --- Step 4: AI Analysis via OpenAI ---
    console.log("🔄 Step 4: Running AI root cause analysis...");
    const aiAnalysis = await analyzeWithOpenAI(anomalies, {
      totalScanned: allStudents.length,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Scan complete in ${elapsed}s`);

    // --- Step 5: Return complete results ---
    const result = {
      message: "Hawke scan complete",
      timestamp: new Date().toISOString(),
      duration_seconds: parseFloat(elapsed),
      total_leads_scanned: allStudents.length,
      sis_records_available: Object.keys(sisMap).length,
      sis_match_rate: `${((Object.keys(sisMap).length / allStudents.length) * 100).toFixed(0)}%`,
      anomalies_detected: anomalies.length,
      by_severity: {
        critical: anomalies.filter((a) => a.severity === "Critical").length,
        high: anomalies.filter((a) => a.severity === "High").length,
        medium: anomalies.filter((a) => a.severity === "Medium").length,
      },
      by_source: {
        crm: anomalies.filter((a) => a.source === "CRM").length,
        sis: anomalies.filter((a) => a.source === "SIS").length,
      },
      anomalies,
      ai_analysis: aiAnalysis,
    };

    res.json(result);
    lastScanResult = result; // Cache for /last-scan endpoint
  } catch (error) {
    console.error("Hawke scan failed:", error.response?.data || error.message);
    res.status(500).json({
      error: "Hawke scan failed",
      details: error.response?.data || error.message,
    });
  }
});

/* ================================
   LIGHTWEIGHT ENDPOINT — Get last scan results
   (for the UI to poll without re-running the full scan)
================================ */

let lastScanResult = null;

app.get("/last-scan", (req, res) => {
  if (!lastScanResult) {
    return res.json({ message: "No scan has been run yet. POST /run-intelligence first." });
  }
  res.json(lastScanResult);
});

/* ================================
   MAVIS DATA ENDPOINT — Raw SIS data
================================ */

app.get("/sis-data", async (req, res) => {
  try {
    const sisMap = await fetchAllSISRecords();
    res.json({
      count: Object.keys(sisMap).length,
      records: Object.values(sisMap),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch SIS data" });
  }
});

/* ================================
   START SERVER
================================ */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke v2 running on port ${PORT}`);
  console.log(`LS_BASE_URL: ${LS_BASE_URL}`);
  console.log(`Mavis: ${MAVIS_BASE_URL}`);
  console.log(`OpenAI: ${OPENAI_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`Mavis API Key: ${MAVIS_API_KEY ? "configured" : "NOT SET"}`);
});
