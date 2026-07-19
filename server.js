/**
 * VESPER MAIL SCHEDULER — NODE.JS SMTP RELAY SERVER
 * ------------------------------------------------
 * This is a local Node.js Express server helper that receives emails from
 * the Vesper web client and forwards them using Nodemailer SMTP transporter.
 * 
 * Requirements:
 * - Node.js installed
 * - Packages: express, cors, nodemailer (run: npm install express cors nodemailer)
 * 
 * Usage:
 * - Start the server using command line:
 *   node server.js
 */

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (process.argv[2] ? parseInt(process.argv[2], 10) : 3000);

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Serve static UI files
app.use(express.static(path.join(__dirname)));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Configure API endpoint to get configuration
app.get("/api/config", (req, res) => {
  const configPath = path.join(__dirname, "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const data = fs.readFileSync(configPath, "utf8");
      return res.json(JSON.parse(data));
    } catch (e) {
      console.error("Error reading config.json:", e);
    }
  }
  return res.json({});
});

// Configure API endpoint to save configuration
app.post("/api/config", (req, res) => {
  const configPath = path.join(__dirname, "config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2), "utf8");
    checkAndStartScheduler(req.body);
    return res.json({ success: true, message: "Configuration saved successfully." });
  } catch (e) {
    console.error("Error writing config.json:", e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Relay email sending route
app.post("/send", async (req, res) => {
  const result = await performNodeSend(req.body);
  if (result.success) {
    return res.status(200).json(result);
  } else {
    return res.status(500).json(result);
  }
});

// Generic email dispatch method
async function performNodeSend(payload) {
  const { 
    action, // 'send' or 'draft'
    host, 
    port, 
    secure, // 'ssl', 'tls', or 'none'
    user, 
    pass, 
    senderEmail, 
    recipientEmail, 
    cc,
    bcc,
    subject, 
    body 
  } = payload;

  // Validate incoming params
  if (!host || !port || !user || !pass || !recipientEmail || !subject || !body) {
    return {
      success: false,
      message: "Missing required SMTP parameters in payload."
    };
  }

  // Handle IMAP Drafting Action
  if (action === "draft") {
    console.log(`\n>>> Processing IMAP Draft request to: ${recipientEmail}`);
    console.log(`    Relaying via Host: ${host}:${port} (SSL: ${secure === 'ssl'})`);
    console.log(`    User: ${user}`);
    
    let ImapFlow;
    try {
      ImapFlow = require("imapflow").ImapFlow;
    } catch (e) {
      console.error(`    [IMAP Error] Missing 'imapflow' package: ${e.message}`);
      return {
        success: false,
        message: "Missing 'imapflow' package on server. Please run: npm install imapflow"
      };
    }

    // Determine IMAP server
    let imapHost = host;
    if (host.includes("smtp.gmail.com")) {
      imapHost = "imap.gmail.com";
    } else if (host.includes("smtp.mail.yahoo.com")) {
      imapHost = "imap.mail.yahoo.com";
    } else if (host.includes("smtp.office365.com") || host.includes("smtp.live.com")) {
      imapHost = "outlook.office365.com";
    } else {
      imapHost = host.replace("smtp.", "imap.");
    }

    console.log(`    Establishing secure IMAP connection to ${imapHost}:993...`);
    const client = new ImapFlow({
      host: imapHost,
      port: 993,
      secure: true,
      auth: {
        user: user,
        pass: pass
      },
      logger: false
    });

    try {
      await client.connect();
      
      // Auto-detect drafts folder
      const list = await client.list();
      let targetFolder = "Drafts";
      for (const folder of list) {
        const name = (folder.name || "").toLowerCase();
        const path = (folder.path || "").toLowerCase();
        if (name.includes("draft") || path.includes("draft")) {
          targetFolder = folder.path;
          break;
        }
      }

      let fromHeader = user;
      if (senderEmail) {
        if (senderEmail.includes('<') && senderEmail.includes('>')) {
          const namePart = senderEmail.split('<')[0].replace(/^["'\s]+|["'\s]+$/g, '');
          const emailPart = senderEmail.split('<')[1].split('>')[0].trim();
          fromHeader = namePart ? `"${namePart}" <${emailPart}>` : emailPart;
        } else {
          const cleanSender = senderEmail.replace(/^["'\s]+|["'\s]+$/g, '');
          fromHeader = cleanSender ? `"${cleanSender}" <${user}>` : user;
        }
      }
      
      const headers = [
        `From: ${fromHeader}`,
        `To: ${recipientEmail}`
      ];
      if (cc) {
        headers.push(`Cc: ${cc}`);
      }
      if (bcc) {
        headers.push(`Bcc: ${bcc}`);
      }
      headers.push(`Subject: ${subject}`);
      headers.push(`MIME-Version: 1.0`);
      headers.push(`Content-Type: text/html; charset=utf-8`);
      headers.push(`Content-Transfer-Encoding: 7bit`);
      headers.push(``);

      const rawMessage = headers.join("\r\n") + "\r\n" + body;

      await client.append(targetFolder, rawMessage, ["\\Draft"]);
      await client.logout();
      
      console.log(`    Draft saved successfully via IMAP!`);
      return {
        success: true,
        message: "Draft saved successfully"
      };
    } catch (error) {
      console.error(`    [IMAP Error] Drafting failed: ${error.message}`);
      try {
        await client.logout();
      } catch (err) {}
      return {
        success: false,
        message: error.message
      };
    }
  }

  // Handle standard SMTP Send Action
  console.log(`\n>>> Processing SMTP Relay request to: ${recipientEmail}`);
  console.log(`    Relaying via Host: ${host}:${port} (SSL: ${secure === 'ssl'})`);
  console.log(`    User: ${user}`);

  try {
    // Configure Transporter
    const transporter = nodemailer.createTransport({
      host: host,
      port: parseInt(port),
      secure: secure === "ssl", // true for port 465, false for other ports
      auth: {
        user: user,
        pass: pass
      },
      tls: {
        // Prevent connection drop on self-signed cert relays
        rejectUnauthorized: false
      }
    });

    // Send Mail Transaction
    let smtpFromHeader = user;
    if (senderEmail) {
      if (senderEmail.includes('<') && senderEmail.includes('>')) {
        const namePart = senderEmail.split('<')[0].replace(/^["'\s]+|["'\s]+$/g, '');
        const emailPart = senderEmail.split('<')[1].split('>')[0].trim();
        smtpFromHeader = namePart ? `"${namePart}" <${emailPart}>` : emailPart;
      } else {
        const cleanSender = senderEmail.replace(/^["'\s]+|["'\s]+$/g, '');
        if (cleanSender.includes('@') && !cleanSender.includes(' ')) {
          smtpFromHeader = cleanSender;
        } else {
          smtpFromHeader = cleanSender ? `"${cleanSender}" <${user}>` : user;
        }
      }
    }

    const mailOptions = {
      from: smtpFromHeader,
      to: recipientEmail,
      subject: subject,
      html: body
    };

    if (cc) {
      mailOptions.cc = cc;
    }
    if (bcc) {
      mailOptions.bcc = bcc;
    }

    const info = await transporter.sendMail(mailOptions);
    console.log(`    Relay Transaction Success! MessageID: ${info.messageId}`);
    
    return {
      success: true,
      message: "Email dispatched successfully",
      messageId: info.messageId
    };

  } catch (error) {
    console.error(`    [SMTP Error] Transmission failed: ${error.message}`);
    return {
      success: false,
      message: error.message
    };
  }
}

// Health check route
app.get(["/health", "/status", "/ping"], (req, res) => {
  return res.status(200).json({
    success: true,
    status: "healthy",
    message: "SMTP Relay Server is active."
  });
});

// BACKGROUND SCHEDULER MANAGEMENT
let schedulerTimeout = null;

function checkAndStartScheduler(config) {
  const settings = config.settings || {};
  const schedulerActive = settings.schedulerActive || false;
  
  if (schedulerActive) {
    if (!schedulerTimeout) {
      console.log("[Background Scheduler] Started.");
      runSchedulerStep();
    }
  } else {
    if (schedulerTimeout) {
      console.log("[Background Scheduler] Stopped.");
      clearTimeout(schedulerTimeout);
      schedulerTimeout = null;
    }
  }
}

async function runSchedulerStep() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    schedulerTimeout = null;
    return;
  }
  
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error("[Background Scheduler] Error reading config:", e.message);
    schedulerTimeout = setTimeout(runSchedulerStep, 5000);
    return;
  }
  
  const settings = config.settings || {};
  const recipients = config.recipients || [];
  const templates = config.templates || [];
  const activeTemplateId = config.activeTemplateId || "";
  
  if (!settings.schedulerActive) {
    console.log("[Background Scheduler] Deactivated by configuration.");
    schedulerTimeout = null;
    return;
  }
  
  const pendingJobs = recipients.filter(r => r.status === "Pending");
  if (pendingJobs.length === 0) {
    console.log("[Background Scheduler] All jobs completed. Stopping scheduler.");
    settings.schedulerActive = false;
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    } catch (e) {}
    schedulerTimeout = null;
    return;
  }
  
  const now = new Date();
  
  for (const rec of pendingJobs) {
    // Check for kill switch in real time
    try {
      const latestConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (!latestConfig.settings || !latestConfig.settings.schedulerActive) {
        console.log("[Background Scheduler] Deactivated by kill switch during dispatch.");
        schedulerTimeout = null;
        return;
      }
    } catch (e) {}
    
    const parsedTime = rec.parsedTime ? new Date(rec.parsedTime) : null;
    if (!parsedTime || now >= parsedTime) {
      console.log(`[Background Scheduler] Processing job for ${rec.name} (${rec.email})...`);
      rec.status = "Sending";
      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      } catch (e) {}
      
      const { success, message } = await sendEmailNode(rec, settings, templates, activeTemplateId);
      
      if (success) {
        rec.status = "Sent";
        delete rec.error;
        console.log(`[Background Scheduler] Successfully sent to ${rec.name}`);
      } else {
        rec.status = "Failed";
        rec.error = message;
        console.log(`[Background Scheduler] Failed to send to ${rec.name}: ${message}`);
      }
      
      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      } catch (e) {}
    }
  }
  
  schedulerTimeout = setTimeout(runSchedulerStep, 5000);
}

async function sendEmailNode(rec, settings, templates, activeTemplateId) {
  const templateId = rec.templateId || activeTemplateId;
  let jobTemplate = null;
  if (templates && templates.length > 0) {
    jobTemplate = templates.find(t => t.id === templateId) || templates[0];
  }
  if (!jobTemplate) {
    return { success: false, message: "No template found." };
  }

  function renderTemplate(templateStr, r) {
    if (!templateStr) return "";
    let text = templateStr;
    const placeholders = {
      "{Name}": r.name || "",
      "{Affiliation}": r.affiliation || "",
      "{Date}": r.date || "",
      "{Technical Schedual Name}": r.techScheduleName || "",
      "{Technical Schedule Name}": r.techScheduleName || "",
      "{tsname}": r.techScheduleName || "",
      "{Session}": r.techScheduleName || "",
      "{session}": r.techScheduleName || "",
      "{Time}": r.time || "",
      "{Email}": r.email || "",
      "{CC}": r.cc || "",
      "{BCC}": r.bcc || "",
      "{Sender}": r.sender || "",
      "{Action}": r.action || ""
    };
    for (const key in placeholders) {
      text = text.split(key).join(placeholders[key]);
    }
    const colValues = r.colValues || {};
    for (const colLetter in colValues) {
      text = text.split(`{${colLetter}}`).join(colValues[colLetter] || "");
    }
    return text;
  }

  const subject = renderTemplate(jobTemplate.subject, rec);
  const body = renderTemplate(jobTemplate.body, rec);

  const senderAccounts = settings.senderAccounts || [];
  const accId = rec.senderAccountId || jobTemplate.senderAccountId;
  let acc = null;
  if (senderAccounts.length > 0) {
    acc = senderAccounts.find(a => a.id === accId) || senderAccounts.find(a => a.isDefault) || senderAccounts[0];
  }
  if (!acc) {
    return { success: false, message: "No sender account configured." };
  }

  function getFinalSenderName(r, account) {
    if (r) {
      if (r.senderName && r.senderName.trim()) {
        return r.senderName.trim();
      }
      if (r.sender && r.sender.trim()) {
        const s = r.sender.trim();
        if (s.includes('<') && s.includes('>')) {
          const namePart = s.split('<')[0].trim().replace(/^["'\s]+|["'\s]+$/g, '');
          if (namePart) return namePart;
        }
        if (!s.includes('@') || s.includes(' ')) {
          return s;
        }
      }
    }
    if (account && account.label && account.label.trim()) {
      return account.label.trim();
    }
    if (account && account.user && account.user.trim()) {
      return account.user.trim();
    }
    return "";
  }

  const finalSenderName = getFinalSenderName(rec, acc);

  const payload = {
    action: rec.action || "send",
    host: acc.host,
    port: acc.port,
    secure: acc.secure,
    user: acc.user,
    pass: acc.pass,
    senderEmail: finalSenderName,
    recipientEmail: rec.email,
    cc: rec.cc || "",
    bcc: rec.bcc || "",
    subject: subject,
    body: body
  };

  return performNodeSend(payload);
}

// Start listening
function startServer(port) {
  const server = app.listen(port, () => {
    console.log("============================================================");
    printBanner();
    console.log(`Server listening on port ${port}`);
    console.log(`Local Relay Route: http://localhost:${port}/send`);
    console.log("Keep this CLI window open to relay SMTP queries.");
    console.log("============================================================");
    
    // Load config and see if scheduler should be started at startup
    const configPath = path.join(__dirname, "config.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        checkAndStartScheduler(config);
      } catch (e) {
        console.error("Error checking scheduler at startup:", e.message);
      }
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`Port ${port} is occupied. Trying next port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error(`[Server Error] Failed to start server: ${err.message}`);
    }
  });
}

startServer(PORT);

function printBanner() {
  console.log("         VESPER MAIL SCHEDULER - NODE RELAY ENGINE        ");
}
