#!/usr/bin/env python3
"""
VESPER MAIL SCHEDULER — ZERO-DEPENDENCY PYTHON SMTP RELAY SERVER
---------------------------------------------------------------
This is a lightweight local HTTP helper server that receives emails from 
the Vesper web dashboard and dispatches them via standard SMTP protocol.

Requirements:
- Python 3.x (Built-in standard libraries only. No PIP install required!)

Usage:
- Double click this file or execute in command line:
  python server.py
"""

import http.server
import socketserver
import json
import smtplib
import sys
import imaplib
import re
import os
import datetime
import threading
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

PORT = int(os.environ.get('PORT', 3000))

# Global scheduler thread lock and control
scheduler_thread = None
scheduler_lock = threading.Lock()

class SMTPRelayHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Override to log cleanly to console
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), format % args))

    def do_OPTIONS(self):
        """Handle CORS pre-flight requests from browser client"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        """Handle health check requests, configuration GET, and static files"""
        if self.path in ('/health', '/status', '/ping'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            response = {'success': True, 'status': 'healthy', 'message': 'SMTP Relay Server is active.'}
            self.wfile.write(json.dumps(response).encode('utf-8'))
        elif self.path == '/api/config':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            config_data = {}
            config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
            if os.path.exists(config_path):
                try:
                    with open(config_path, 'r', encoding='utf-8') as f:
                        config_data = json.load(f)
                except Exception as e:
                    print(f"Error reading config.json: {e}")
            self.wfile.write(json.dumps(config_data).encode('utf-8'))
        else:
            # Handle static file serving
            clean_path = self.path.split('?')[0].split('#')[0]
            if clean_path == '/':
                clean_path = '/index.html'
            
            # Remove leading slash
            rel_path = clean_path.lstrip('/')
            file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), rel_path)
            
            # Secure path check to prevent directory traversal
            script_dir = os.path.dirname(os.path.abspath(__file__))
            real_file_path = os.path.realpath(file_path)
            if not real_file_path.startswith(os.path.realpath(script_dir)):
                self.send_response(403)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(b"Access Denied")
                return
                
            if os.path.exists(real_file_path) and os.path.isfile(real_file_path):
                # Determine content type
                content_type = 'text/plain'
                if real_file_path.endswith('.html'):
                    content_type = 'text/html; charset=utf-8'
                elif real_file_path.endswith('.css'):
                    content_type = 'text/css; charset=utf-8'
                elif real_file_path.endswith('.js'):
                    content_type = 'application/javascript; charset=utf-8'
                elif real_file_path.endswith('.json'):
                    content_type = 'application/json; charset=utf-8'
                elif real_file_path.endswith('.ico'):
                    content_type = 'image/x-icon'
                
                try:
                    with open(real_file_path, 'rb') as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                    self.end_headers()
                    self.wfile.write(content)
                except Exception as e:
                    self.send_response(500)
                    self.send_header('Content-Type', 'text/plain')
                    self.end_headers()
                    self.wfile.write(f"Error reading file: {str(e)}".encode('utf-8'))
            else:
                self.send_response(404)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(b"File not found")

    def do_POST(self):
        """Relay SMTP requests or handle configuration POST"""
        if self.path == '/api/config':
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self.send_error_response("Empty request body")
                return

            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8'))
            except Exception as e:
                self.send_error_response(f"Invalid JSON payload: {str(e)}")
                return

            config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
            try:
                with open(config_path, 'w', encoding='utf-8') as f:
                    json.dump(payload, f, indent=2, ensure_ascii=False)
                
                # Check and trigger background scheduler if active
                check_and_start_scheduler(payload)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True, 'message': 'Configuration saved successfully.'}).encode('utf-8'))
            except Exception as e:
                self.send_error_response(f"Failed to save configuration: {str(e)}", code=500)
            return

        if self.path != '/send':
            self.send_error_response("Endpoint not found. Use POST to /send", code=404)
            return

        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            self.send_error_response("Empty request body")
            return

        post_data = self.rfile.read(content_length)
        
        try:
            payload = json.loads(post_data.decode('utf-8'))
        except Exception as e:
            self.send_error_response(f"Invalid JSON payload: {str(e)}")
            return

        success, msg = perform_email_dispatch(payload)
        if success:
            self.send_success_response()
        else:
            self.send_error_response(msg)

    def send_success_response(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        response = {'success': True, 'message': 'Email relayed successfully.'}
        self.wfile.write(json.dumps(response).encode('utf-8'))

    def send_error_response(self, message, code=400):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        response = {'success': False, 'message': message}
        self.wfile.write(json.dumps(response).encode('utf-8'))

def perform_email_dispatch(payload):
    action = payload.get('action', 'send')
    host = payload.get('host')
    port = payload.get('port')
    secure = payload.get('secure', 'ssl') # 'ssl', 'tls', or 'none'
    user = payload.get('user')
    password = payload.get('pass')
    sender = payload.get('senderEmail')
    recipient = payload.get('recipientEmail')
    cc = payload.get('cc')
    bcc = payload.get('bcc')
    subject = payload.get('subject')
    body = payload.get('body')

    if not all([host, port, user, password, recipient, subject, body]):
        return False, "Missing required SMTP fields (host, port, user, pass, recipientEmail, subject, body)"

    print(f"\n>>> Incoming relay request for: {recipient}")
    if cc:
        print(f"    CC: {cc}")
    if bcc:
        print(f"    BCC: {bcc}")
    print(f"    SMTP Host: {host}:{port} (Security: {secure})")
    print(f"    SMTP User: {user}")

    try:
        # Create email envelope list
        envelope_recipients = [recipient]
        if cc:
            envelope_recipients.extend([email.strip() for email in cc.split(',') if email.strip()])
        if bcc:
            envelope_recipients.extend([email.strip() for email in bcc.split(',') if email.strip()])

        # Create email headers
        msg = MIMEMultipart()
        if sender:
            if '<' in sender and '>' in sender:
                name_part = sender.split('<')[0].strip('\'" ')
                email_part = sender.split('<')[1].split('>')[0].strip()
                msg['From'] = f'"{name_part}" <{email_part}>' if name_part else email_part
            else:
                clean_sender = sender.strip('\'" ')
                if '@' in clean_sender and ' ' not in clean_sender:
                    msg['From'] = clean_sender
                else:
                    msg['From'] = f'"{clean_sender}" <{user}>' if clean_sender else user
        else:
            msg['From'] = user
        print("<<<<<<<<<<<<",msg)
        msg['To'] = recipient
        if cc:
            msg['Cc'] = cc
        msg['Subject'] = subject
        
        # Format text body as HTML
        msg.attach(MIMEText(body, 'html', 'utf-8'))

        # Setup SMTP Connection
        if action == 'draft':
            print(f"    Creating draft in IMAP server for {recipient}...")
            
            # For drafts, we want to include the Bcc header in the message so it saves correctly
            if bcc:
                msg['Bcc'] = bcc

            # Determine IMAP server
            imap_host = host
            if "smtp.gmail.com" in host:
                imap_host = "imap.gmail.com"
            elif "smtp.mail.yahoo.com" in host:
                imap_host = "imap.mail.yahoo.com"
            elif "smtp.office365.com" in host or "smtp.live.com" in host:
                imap_host = "outlook.office365.com"
            else:
                imap_host = host.replace("smtp.", "imap.")
            
            print(f"    Establishing secure IMAP connection to {imap_host}:993...")
            mail = imaplib.IMAP4_SSL(imap_host, 993, timeout=15)
            mail.login(user, password)
            
            # Try to auto-detect Drafts folder name
            typ, folders = mail.list()
            target_folder = "Drafts"
            for f in folders:
                f_str = f.decode('utf-8', errors='ignore')
                if "Drafts" in f_str or "draft" in f_str.lower():
                    match = re.search(r'"([^"]+)"$', f_str)
                    if match:
                        target_folder = match.group(1)
                        break
                    else:
                        parts = f_str.split(' ')
                        target_folder = parts[-1]
                        break

            print(f"    Appending message to IMAP Folder: {target_folder}...")
            mail.append(target_folder, '\\Draft', None, msg.as_bytes())
            mail.logout()
            print("    Draft saved successfully via IMAP!\n")
            return True, "Draft saved successfully."

        if secure == 'ssl':
            # SSL Connection (typically port 465)
            print("    Establishing secure SSL connection...")
            server = smtplib.SMTP_SSL(host, int(port), timeout=10)
        else:
            # Standard TCP connection (typically port 587 or 25)
            print("    Establishing standard connection...")
            server = smtplib.SMTP(host, int(port), timeout=10)
            if secure == 'tls':
                # Start TLS handshake (STARTTLS)
                print("    Upgrading connection via STARTTLS...")
                server.starttls()

        # Authenticate and send
        print("    Logging into SMTP server...")
        server.login(user, password)
        
        print("    Sending payload message...")
        server.sendmail(user, envelope_recipients, msg.as_string())
        
        # Close connection cleanly
        server.quit()
        print("    Transaction completed successfully!\n")
        return True, "Email relayed successfully."

    except smtplib.SMTPAuthenticationError:
        err_msg = "SMTP Authentication failed. Please check your username and password/app-specific password."
        print(f"    [Error] {err_msg}")
        return False, err_msg
    except Exception as e:
        err_msg = f"SMTP Transmission failure: {str(e)}"
        print(f"    [Error] {err_msg}")
        return False, err_msg


def send_email_backend(rec, settings, templates, active_template_id):
    template_id = rec.get('templateId') or active_template_id
    job_template = None
    if templates:
        for t in templates:
            if t.get('id') == template_id:
                job_template = t
                break
    if not job_template and templates:
        job_template = templates[0]
        
    if not job_template:
        return False, "No template found."

    def render_template(template_str, r):
        if not template_str:
            return ""
        text = template_str
        placeholders = {
            "{Name}": r.get('name', ''),
            "{Affiliation}": r.get('affiliation', ''),
            "{Date}": r.get('date', ''),
            "{Technical Schedual Name}": r.get('techScheduleName', ''),
            "{Technical Schedule Name}": r.get('techScheduleName', ''),
            "{tsname}": r.get('techScheduleName', ''),
            "{Session}": r.get('techScheduleName', ''),
            "{session}": r.get('techScheduleName', ''),
            "{Time}": r.get('time', ''),
            "{Email}": r.get('email', ''),
            "{CC}": r.get('cc', ''),
            "{BCC}": r.get('bcc', ''),
            "{Sender}": r.get('sender', ''),
            "{Action}": r.get('action', '')
        }
        for k, v in placeholders.items():
            text = text.replace(k, v or "")
            
        col_values = r.get('colValues', {})
        if col_values:
            for col_letter, val in col_values.items():
                text = text.replace(f"{{{col_letter}}}", val or "")
        return text

    subject = render_template(job_template.get('subject', ''), rec)
    body = render_template(job_template.get('body', ''), rec)

    sender_accounts = settings.get('senderAccounts', [])
    acc_id = rec.get('senderAccountId') or job_template.get('senderAccountId')
    acc = None
    if sender_accounts:
        for a in sender_accounts:
            if a.get('id') == acc_id:
                acc = a
                break
        if not acc:
            for a in sender_accounts:
                if a.get('isDefault'):
                    acc = a
                    break
            if not acc and sender_accounts:
                acc = sender_accounts[0]

    if not acc:
        return False, "No sender account configured."

    def get_final_sender_name(r, account):
        if r:
            sender_name = str(r.get('senderName') or '').strip()
            if sender_name:
                return sender_name
            sender = str(r.get('sender') or '').strip()
            if sender:
                if '<' in sender and '>' in sender:
                    name_part = sender.split('<')[0].strip('\'" ')
                    if name_part:
                        return name_part
                if '@' not in sender or ' ' in sender:
                    return sender
        if account:
            label = str(account.get('label') or '').strip()
            if label:
                return label
            user = str(account.get('user') or '').strip()
            if user:
                return user
        return ""

    final_sender_name = get_final_sender_name(rec, acc)

    payload = {
        'action': rec.get('action') or 'send',
        'host': acc.get('host'),
        'port': acc.get('port'),
        'secure': acc.get('secure', 'ssl'),
        'user': acc.get('user'),
        'pass': acc.get('pass'),
        'senderEmail': final_sender_name,
        'recipientEmail': rec.get('email'),
        'cc': rec.get('cc') or '',
        'bcc': rec.get('bcc') or '',
        'subject': subject,
        'body': body
    }

    return perform_email_dispatch(payload)


def background_scheduler_loop():
    global scheduler_thread
    print("[Background Scheduler] Loop started.")
    
    while True:
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
        if not os.path.exists(config_path):
            break
            
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
        except Exception as e:
            print(f"[Background Scheduler] Error reading config: {e}")
            time.sleep(5)
            continue
            
        settings = config.get('settings', {})
        recipients = config.get('recipients', [])
        templates = config.get('templates', [])
        active_template_id = config.get('activeTemplateId', '')
        
        # Check if scheduler is still active
        if not settings.get('schedulerActive', False):
            print("[Background Scheduler] Terminated: Marked inactive in settings.")
            break
            
        # Check for due jobs
        pending_jobs = [r for r in recipients if r.get('status') == 'Pending']
        if not pending_jobs:
            print("[Background Scheduler] All jobs completed. Stopping scheduler.")
            settings['schedulerActive'] = False
            try:
                with open(config_path, 'w', encoding='utf-8') as f:
                    json.dump(config, f, indent=2, ensure_ascii=False)
            except Exception as e:
                print(f"[Background Scheduler] Error writing status: {e}")
            break
            
        now = datetime.datetime.now()
        
        def parse_iso_time(iso_str):
            if not iso_str:
                return None
            try:
                clean_str = iso_str.split('.')[0].replace('Z', '')
                if 'T' in clean_str:
                    return datetime.datetime.strptime(clean_str, '%Y-%m-%dT%H:%M:%S')
                else:
                    return datetime.datetime.strptime(clean_str, '%Y-%m-%d %H:%M:%S')
            except Exception as e:
                return None

        # Dispatch due jobs
        for rec in pending_jobs:
            # Check if scheduler was stopped mid-execution
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    latest = json.load(f)
                    if not latest.get('settings', {}).get('schedulerActive', False):
                        print("[Background Scheduler] Terminated: Stopped mid-run.")
                        break
            except Exception:
                pass

            parsed_time_str = rec.get('parsedTime')
            parsed_time = parse_iso_time(parsed_time_str) if parsed_time_str else None
            
            if not parsed_time or now >= parsed_time:
                print(f"[Background Scheduler] Sending email to {rec.get('name')}...")
                rec['status'] = 'Sending'
                try:
                    with open(config_path, 'w', encoding='utf-8') as f:
                        json.dump(config, f, indent=2, ensure_ascii=False)
                except Exception:
                    pass
                    
                success, error_msg = send_email_backend(rec, settings, templates, active_template_id)
                
                if success:
                    rec['status'] = 'Sent'
                    if 'error' in rec:
                        del rec['error']
                else:
                    rec['status'] = 'Failed'
                    rec['error'] = error_msg
                    
                try:
                    with open(config_path, 'w', encoding='utf-8') as f:
                        json.dump(config, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"[Background Scheduler] Error saving state: {e}")
                    
        time.sleep(5)
        
    with scheduler_lock:
        scheduler_thread = None
    print("[Background Scheduler] Loop ended.")


def check_and_start_scheduler(config):
    global scheduler_thread
    settings = config.get('settings', {})
    scheduler_active = settings.get('schedulerActive', False)
    
    if scheduler_active:
        with scheduler_lock:
            if scheduler_thread is None:
                scheduler_thread = threading.Thread(target=background_scheduler_loop, daemon=True)
                scheduler_thread.start()

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    pass

if __name__ == '__main__':
    # Parse port argument if provided
    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port argument '{sys.argv[1]}'. Using default {PORT}.")

    server = None
    while True:
        try:
            server = ThreadingHTTPServer(('0.0.0.0', port), SMTPRelayHandler)
            break
        except OSError as e:
            # Check for address already in use (EADDRINUSE / WinError 10048)
            print(f"Port {port} is occupied. Trying next port {port + 1}...")
            port += 1
            if port > 3100:  # limit search range to avoid infinite loop
                print("Could not find an available port between 3000 and 3100.")
                sys.exit(1)

    print("=" * 60)
    print("           VESPER MAIL SCHEDULER SMTP RELAY SERVER          ")
    print("=" * 60)
    print(f"Starting server on port {port}...")
    print(f"Web UI available at: http://localhost:{port}")
    print(f"Relay listening at:  http://localhost:{port}/send")
    print("Keep this window open to run the scheduler and process emails.")
    print("Press Ctrl+C to terminate.")
    print("-" * 60)

    # Load config and see if scheduler should be started at startup
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
                check_and_start_scheduler(config)
        except Exception as e:
            print(f"Error checking scheduler at startup: {e}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down SMTP Relay server. Goodbye.")
        sys.exit(0)
