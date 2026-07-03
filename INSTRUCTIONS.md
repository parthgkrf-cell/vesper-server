# Vesper Mail Scheduler — Personal Email Campaign Guide

Welcome to **Vesper Mail Scheduler**, a premium email client and custom campaign scheduler. This application enables you to design personalized emails, import lists directly from Excel, and schedule delivery times.

---

## 🚀 How to Launch the Application

1. Open PowerShell or Command Prompt.
2. Navigate to the project folder and launch the Python server:
   ```bash
   python server.py
   ```
3. Open your web browser and navigate to:
   [http://localhost:3000](http://localhost:3000)
4. The Vesper dashboard will load immediately, fully connected to your backend SMTP relay.

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

Vesper operates entirely through standard email protocols via the local backend helper server:

### 1. Backend Email Send (SMTP)
* **How it works:** Emails are sent automatically in the background using standard SMTP protocol via the local helper server. No browser windows or desktop clients are opened.
* **Setup:** Add your email credentials, SMTP host (e.g. `smtp.gmail.com`), and port in the Configuration panel. For Gmail accounts, you must use a 16-digit Google App Password.

### 2. Backend Email Draft (IMAP)
* **How it works:** Instead of sending immediately, Vesper connects to your email provider via IMAP and saves the customized messages directly to your **Drafts** folder.
* **Pros:** Allows you to preview and manually review/send the emails from your actual mail app.

---

## ⚡ Quick-Start Operations Checklist
1. **Launch `server.py`** and open `http://localhost:3000` in your browser.
2. In the **Import Excel** tab, click **Download Sample Excel** to see the format. Edit it to add your contacts and schedule slots.
3. Drag and drop your updated Excel file back into the **Import Excel** dropzone.
4. Go to **Compose Template** and customize your Subject and Body. Use the **Personalized Live Preview** dropdown to double-check that variable replacement works properly.
5. In **Configuration**, add your SMTP accounts and set one as default.
6. Click **Start Scheduler** in the bottom-left sidebar.
7. Go to **Schedule & Queue** to monitor remaining countdowns, trigger emails immediately, and view real-time log messages.
