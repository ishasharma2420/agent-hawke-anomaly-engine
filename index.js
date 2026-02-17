import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const {
  LS_ACCESS_KEY,
  LS_SECRET_KEY,
  LS_BASE_URL
} = process.env;

app.get("/", (req, res) => {
  res.send("Agent Hawke is live 🦅");
});

app.post("/run-intelligence", async (req, res) => {
  try {

    console.log("=== RUN INTELLIGENCE START ===");

    const response = await axios.post(
      `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
      {
        Paging: {
          PageIndex: 1,
          PageSize: 5
        }
      },
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY
        },
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("=== RAW RESPONSE START ===");
    console.log(JSON.stringify(response.data, null, 2));
    console.log("=== RAW RESPONSE END ===");

    // Try both possible formats
    const leadsFromLeadsKey = response.data?.Leads || [];
    const leadsFromDataKey = response.data?.Data || [];

    console.log("Leads key count:", leadsFromLeadsKey.length);
    console.log("Data key count:", leadsFromDataKey.length);

    const finalLeads =
      leadsFromLeadsKey.length > 0
        ? leadsFromLeadsKey
        : leadsFromDataKey;

    console.log(`Final extracted leads: ${finalLeads.length}`);

    res.json({
      message: "Hawke debug scan complete",
      leadsKeyCount: leadsFromLeadsKey.length,
      dataKeyCount: leadsFromDataKey.length,
      finalExtracted: finalLeads.length
    });

  } catch (error) {
    console.error("ERROR DETAILS:");
    console.error(error.response?.data || error.message);

    res.status(500).json({
      error: "Debug fetch failed"
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke running on port ${PORT}`);
});
