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

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (process.argv[2] ? parseInt(process.argv[2], 10) : 3000);

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Relay email sending route
app.post("/send", async (req, res) => {
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
  } = req.body;

  // Validate incoming params
  if (!host || !port || !user || !pass || !recipientEmail || !subject || !body) {
    return res.status(400).json({
      success: false,
      message: "Missing required SMTP parameters in payload."
    });
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
      return res.status(500).json({
        success: false,
        message: "Missing 'imapflow' package on server. Please run: npm install imapflow"
      });
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

      console.log(`    Appending message to IMAP Folder: ${targetFolder}...`);
      const fromHeader = senderEmail ? `"${senderEmail}" <${user}>` : user;
      
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
      return res.status(200).json({
        success: true,
        message: "Draft saved successfully"
      });
    } catch (error) {
      console.error(`    [IMAP Error] Drafting failed: ${error.message}`);
      try {
        await client.logout();
      } catch (err) {}
      return res.status(500).json({
        success: false,
        message: error.message
      });
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
    const mailOptions = {
      from: senderEmail ? `"${senderEmail}" <${user}>` : user,
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
    
    return res.status(200).json({
      success: true,
      message: "Email dispatched successfully",
      messageId: info.messageId
    });

  } catch (error) {
    console.error(`    [SMTP Error] Transmission failed: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Health check route
app.get(["/health", "/status", "/ping"], (req, res) => {
  return res.status(200).json({
    success: true,
    status: "healthy",
    message: "SMTP Relay Server is active."
  });
});

// Start listening
function startServer(port) {
  const server = app.listen(port, () => {
    console.log("============================================================");
    printBanner();
    console.log(`Server listening on port ${port}`);
    console.log(`Local Relay Route: http://localhost:${port}/send`);
    console.log("Keep this CLI window open to relay SMTP queries.");
    console.log("============================================================");
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
