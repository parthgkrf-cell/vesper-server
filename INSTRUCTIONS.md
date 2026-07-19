# Vesper Mail Scheduler — Personal Email Campaign Guide

Welcome to **Vesper Mail Scheduler**, a premium email client and custom campaign scheduler designed for 24/7 background cloud operation. This application enables you to design personalized emails, import lists directly from Excel, and schedule delivery times.

---

## ☁️ Cloud Deployment & Startup

Vesper is architected to run continuously in the cloud (e.g., on a VPS, Heroku, or PythonAnywhere). Since the scheduler runs directly in the server background, it will process your queue 24/7 even if you close the dashboard webpage, close your browser, or turn off your device.

To run or deploy the service:
* **Python Engine:** Run `python server.py [port]` to launch the unified server.
* **Node Engine:** Run `node server.js [port]` to launch the Node-based version.
Once deployed, navigate to the host domain in your browser to access the dashboard.

---

## 📁 Excel Template Setup

To schedule your emails, your Excel sheet must contain the following column headers in the **first row (Sheet 1)**:

* **Name**: The recipient's full name (e.g., `John Doe`).
* **Email**: The recipient's email address (e.g., `john.doe@company.com`).
* **Affiliation**: The company, school, or organization (e.g., `Google`, `Harvard`). If left empty, it defaults to `Independent`.
* **Template** (Optional): Name or ID of the template to assign to this recipient (e.g. `Default Template`, `Follow-up`).
* **S_Date** & **S_Time** (Two-column format):
  * **S_Date**: Scheduled send date (e.g., `2026-07-25` or `25/07/2026`).
  * **S_Time**: Scheduled send time (e.g., `02:30 PM`, `14:30`, `10:15:00`).
* **S_Time** (Single-column format):
  * You can also use a single column (`S_Time` or `Time`) containing both date and time (e.g., `2026-06-26 15:30:00`) or time-only relative to today (`02:15 PM`).

> [!TIP]
> Inside the app's **Import Excel** tab, click **Download Sample Excel** to download a pre-formatted template with multi-sheet, multi-template, and `S_Date` / `S_Time` test rows!

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

Vesper operates entirely through standard email protocols via the server background engine:

### 1. Cloud Email Send (SMTP)
* **How it works:** Emails are sent automatically in the background using standard SMTP protocol via the server. No browser windows or desktop clients are opened.
* **Setup:** Add your email credentials, SMTP host (e.g. `smtp.gmail.com`), and port in the Configuration panel. For Gmail accounts, you must use a 16-digit Google App Password.

### 2. Cloud Email Draft (IMAP)
* **How it works:** Instead of sending immediately, Vesper connects to your email provider via IMAP and saves the customized messages directly to your **Drafts** folder.
* **Pros:** Allows you to preview and manually review/send the emails from your actual mail app.

---

## ⚡ Quick-Start Operations Checklist
1. Open the Vesper dashboard in your browser.
2. In the **Import Excel** tab, click **Download Sample Excel** to see the format. Edit it to add your contacts and schedule slots.
3. Drag and drop your updated Excel file back into the **Import Excel** dropzone.
4. Go to **Compose Template** and customize your Subject and Body. Use the **Personalized Live Preview** dropdown to double-check that variable replacement works properly.
5. In **Configuration**, add your SMTP accounts and set one as default.
6. Click **Start Scheduler** in the bottom-left sidebar.
7. Go to **Schedule & Queue** to monitor remaining countdowns, trigger emails immediately, and view real-time status updates from the cloud.
