# Vesper Mail Scheduler — Personal Email Campaign Guide

Welcome to **Vesper Mail Scheduler**, a premium, client-side email client and custom campaign scheduler. This application enables you to design personalized emails, import lists directly from Excel, and schedule delivery times.

---

## 🚀 How to Launch the Application

1. Open your File Explorer and navigate to:
   [C:/Users/parth/vesper-mail-scheduler](file:///C:/Users/parth/vesper-mail-scheduler)
2. Double-click the `index.html` file.
3. The Vesper dashboard will launch in your default web browser immediately (Chrome, Edge, Firefox, or Safari).

---

## 📁 Excel Template Setup

To schedule your emails, your Excel sheet must contain the following column headers in the **first row (Sheet 1)**:

* **Name**: The recipient's full name (e.g., `John Doe`).
* **Email**: The recipient's email address (e.g., `john.doe@company.com`).
* **Affiliation**: The company, school, or organization (e.g., `Google`, `Harvard`). If left empty, it defaults to `Independent`.
* **Time**: The date/time you want to schedule the email. You can specify this in multiple formats:
  * **Absolute Date & Time**: `2026-06-26 15:30:00` (YYYY-MM-DD HH:MM:SS)
  * **Time-only (Relative to today)**: `02:15 PM` or `14:15` (defaults to today's date at that time; if that time has already passed today, it will schedule for tomorrow).
  * **Blank / empty**: Will schedule the email to send **immediately** when the scheduler is started.

> [!TIP]
> Inside the app's **Import Excel** tab, you can click the **Download Sample Excel** button to download a pre-formatted template with test rows!

---

## ✉️ Dynamic Personalization (Merge Tags)

When writing your email template in the **Compose Template** tab, you can use these special placeholders:
* `{Name}` — Inserts the recipient's Name.
* `{Email}` — Inserts the recipient's Email address.
* `{Affiliation}` — Inserts the recipient's Affiliation/Company.
* `{Time}` — Inserts the recipient's scheduled delivery slot.

**Example subject:**
`Regarding your work at {Affiliation}`

**Example body:**
`Hi {Name}, quick follow-up to see how things are going at {Affiliation}. I've scheduled this message to hit your inbox ({Email}) at {Time}.`

---

## ⚙️ Understanding Sending Modes

Navigate to the **Configuration** tab to select how you want to send your emails:

### 1. Desktop Mail Client (mailto:) — *Default & Recommended*
* **How it works:** When the scheduled time arrives, Vesper triggers a system link that pops open your default email app (Outlook, Windows Mail, Apple Mail, or Gmail Web) with the recipient's email, subject line, and body **fully pre-filled**.
* **Pros:** Extremely secure. No setups, API keys, or passwords needed. The emails are sent directly through your actual personal mail client, maintaining perfect authenticity.
* **Cons:** Requires you to click "Send" in the opened client window. Perfect for small, high-quality, personal lists.

### 2. Brevo API (Sendinblue) — *Fully Automated*
* **How it works:** Emails are sent automatically in the background using Brevo's SMTP Web API.
* **Setup:**
  1. Register for a free account at [brevo.com](https://www.brevo.com) (takes 2 minutes).
  2. Create an API key under **SMTP & API** tab.
  3. Paste your API Key, sender email, and sender name into the Vesper Configuration panel.
* **Pros:** Sends emails in the background hands-free. Free tier lets you send up to 300 emails per day without adding a credit card.

### 3. Resend API — *Developer API*
* **How it works:** Emails are sent automatically in the background using Resend's REST API.
* **Setup:** Create a free account at [resend.com](https://resend.com), generate an API Key, and verify your sending domain/email.
* **Pros:** Hands-free background queue, 100 free emails per day.

### 4. Backend Email Send (SMTP) & Backend Email Draft (IMAP) — *Local Helpers*
* **How it works:** Runs a lightweight local server on your computer that connects to standard email providers (Gmail App Passwords, Outlook, Yahoo, Custom company servers) via SMTP (to send) or IMAP (to save drafts in the background without opening browser windows).
* **Auto-port selection:** If port 3000 is occupied, the servers will automatically search and bind to the next available port (e.g. 3001, 3002) and print the corresponding URL. You can also manually specify a port as a command line argument.
* **To run the Python server:**
  1. Open PowerShell or Command Prompt.
  2. Run the command:
     ```powershell
     C:\Users\parth\vesper-mail-scheduler\start_server.bat [port]
     ```
     *(e.g., `C:\Users\parth\vesper-mail-scheduler\start_server.bat 3001` to force port 3001)*
  3. Keep the terminal window open. Copy the printed Local Relay Route (e.g. `http://localhost:3001/send`) and paste it into the **Helper Server URL** setting under the **Configuration** tab in Vesper.
  4. Input your email credentials, SMTP/IMAP host, and port, and start drafting/sending at the backend.
* **To run the Node.js server (Alternative):**
  1. Install Node.js on your computer.
  2. Navigate to the project directory in command line and run:
     ```bash
     npm install express cors nodemailer imapflow
     node server.js [port]
     ```
  3. Copy the printed Local Relay Route (e.g. `http://localhost:3001/send`) and paste it into the **Helper Server URL** setting under the **Configuration** tab in Vesper.

---

## ⚡ Quick-Start Operations Checklist
1. **Double-click** `index.html` to open the app.
2. In the **Import Excel** tab, click **Download Sample Excel** to see the format. Edit it to add your contacts and schedule slots.
3. Drag and drop your updated Excel file back into the **Import Excel** dropzone.
4. Go to **Compose Template** and customize your Subject and Body. Use the **Personalized Live Preview** dropdown to double-check that variable replacement works properly.
5. In **Configuration**, choose your sending method (try `Desktop Mail Client` first or run `server.py`).
6. Click **Start Scheduler** in the bottom-left sidebar.
7. Go to **Schedule & Queue** to monitor remaining countdowns, trigger emails immediately, and view real-time log messages.
