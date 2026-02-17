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

   const response = await axios.post(
  `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
  {
    Parameter: {
      Stage: {
        Values: [
          "Engagement Initiated",
          "Application Pending",
          "Application Completed"
        ],
        Operator: "IN"
      }
    },
    Paging: {
      PageIndex: 1,
      PageSize: 50
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

const leads = response.data?.Leads || [];

    const leads = response.data?.Leads || [];

    console.log(`Fetched ${leads.length} leads`);

    res.json({
      message: "Hawke scanned pipeline stages",
      scanned: leads.length
    });

  } catch (error) {
    console.error("Error fetching leads:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to fetch leads"
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke running on port ${PORT}`);
});
