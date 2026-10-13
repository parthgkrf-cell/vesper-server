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
import random
import socket
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.header import Header
import email.utils
import html

PORT = int(os.environ.get('PORT', 3000))

def sanitize_smtp_host_and_port(raw_host, raw_port=None):
    """
    Sanitizes raw SMTP host string:
    - Strips leading/trailing whitespace, quotes, backticks
    - Removes protocol schemes (ssl://, tls://, smtps://, smtp://, http://, https://, imap://, etc.)
    - Extracts embedded ports (e.g., 'smtp.gmail.com:465' -> host='smtp.gmail.com', port=465)
    - Strips trailing slashes, paths, or query parameters
    - Auto-corrects common missing 'smtp.' prefix for major email providers
    """
    if not raw_host:
        return "", raw_port

    host_str = str(raw_host).strip().strip('\'"`')

    # Remove protocol / scheme prefixes
    host_str = re.sub(r'^(?:[a-z0-9+\-.]+://)', '', host_str, flags=re.IGNORECASE)

    # Strip trailing path/slashes or query parameters
    host_str = host_str.split('/')[0].split('?')[0].strip()

    # Check for embedded port e.g. "smtp.gmail.com:465"
    parsed_port = raw_port
    if ':' in host_str:
        parts = host_str.split(':')
        host_str = parts[0].strip()
        if len(parts) > 1 and parts[1].strip().isdigit():
            parsed_port = int(parts[1].strip())

    # Lowercase for domain matching
    host_lower = host_str.lower()

    # Auto-correct common missing 'smtp.' prefix or domain-only host entries
    if host_lower in ('gmail.com', 'googlemail.com'):
        host_str = 'smtp.gmail.com'
    elif host_lower in ('outlook.com', 'hotmail.com', 'live.com', 'office365.com', 'microsoft.com', 'msn.com'):
        host_str = 'smtp.office365.com'
    elif host_lower in ('yahoo.com', 'ymail.com', 'rocketmail.com'):
        host_str = 'smtp.mail.yahoo.com'
    elif host_lower in ('zoho.com'):
        host_str = 'smtp.zoho.com'
    elif host_lower in ('icloud.com', 'me.com', 'mac.com'):
        host_str = 'smtp.mail.me.com'

    return host_str, parsed_port


def sanitize_password(raw_pass):
    """
    Sanitizes SMTP passwords:
    - Strips non-breaking spaces (\xa0), zero-width spaces (\u200b), newlines, tabs, outer quotes
    - Compacts spaces/hyphens if removing them results in a 16-character string (Google 16-digit App Password format)
    """
    if not raw_pass:
        return ""
    clean = str(raw_pass).replace('\xa0', '').replace('\u200b', '').replace('\r', '').replace('\n', '').strip().strip('\'"')
    compact = re.sub(r'[\s\-]+', '', clean)
    if len(compact) == 16:
        return compact
    return clean


def perform_connection_test(payload):
    """
    Tests SMTP connection and authentication for a specific sender account without sending an email.
    """
    raw_host = payload.get('host')
    raw_port = payload.get('port')
    secure = payload.get('secure', 'ssl')
    user = str(payload.get('user') or '').replace('\xa0', '').replace('\u200b', '').strip().strip('\'"')
    raw_pass = payload.get('pass')
    password = sanitize_password(raw_pass)

    host, port = sanitize_smtp_host_and_port(raw_host, raw_port)

    if not host or not port or not user or not password:
        return False, "Missing host, port, username, or password for connection test."

    try:
        if secure == 'ssl':
            server = smtplib.SMTP_SSL(host, int(port), timeout=10)
        else:
            server = smtplib.SMTP(host, int(port), timeout=10)
            if secure == 'tls':
                server.starttls()
        
        server.login(user, password)
        server.quit()
        return True, f"SMTP Connection & Authentication Successful for '{user}'!"
    except smtplib.SMTPAuthenticationError:
        if 'gmail' in host.lower() or 'google' in host.lower() or 'gmail' in user.lower():
            err_msg = f"SMTP Authentication failed for '{user}'. For Gmail/Google Workspace, ensure 2-Step Verification is ON and a 16-digit App Password is used (without spaces)."
        else:
            rec_host, provider_name = check_domain_mx_provider(host)
            if provider_name:
                err_msg = f"SMTP Authentication failed for '{user}'. Provider Detected: {provider_name}. For Google Workspace, ensure a 16-digit App Password is used."
            else:
                err_msg = f"SMTP Authentication failed for '{user}'. Please verify your username and password."
        return False, err_msg
    except (socket.gaierror, socket.herror):
        if 'gmail' in host.lower() or 'google' in host.lower():
            err_msg = f"DNS resolution failed for host '{host}'."
        else:
            rec_host, provider_name = check_domain_mx_provider(host)
            if rec_host:
                err_msg = f"SMTP Host '{host}' could not be resolved. Provider Detected: {provider_name}. Suggested host: '{rec_host}'."
            else:
                err_msg = f"DNS resolution failed for host '{host}'."
        return False, err_msg
    except socket.timeout:
        return False, f"Connection timed out for host '{host}:{port}'."
    except Exception as e:
        return False, f"Connection check failed: {str(e)}"



def check_domain_mx_provider(host_str):
    """
    Checks MX record for custom domains (e.g., gr.foundation) to detect
    if it uses Google Workspace, Microsoft 365, Yahoo, or Zoho.
    """
    try:
        domain = host_str
        if domain.startswith("smtp."):
            domain = domain[5:]
        elif domain.startswith("mail."):
            domain = domain[5:]

        import subprocess
        cmd = f"nslookup -type=MX {domain}"
        out = subprocess.check_output(cmd, shell=True, timeout=3, stderr=subprocess.STDOUT).decode('utf-8', errors='ignore').lower()

        if 'google.com' in out or 'aspmx' in out:
            return 'smtp.gmail.com', 'Google Workspace (Gmail)'
        if 'outlook.com' in out or 'protection.outlook.com' in out:
            return 'smtp.office365.com', 'Microsoft 365 / Outlook'
        if 'yahoodns.net' in out or 'yahoo' in out:
            return 'smtp.mail.yahoo.com', 'Yahoo Mail'
        if 'zoho' in out:
            return 'smtp.zoho.com', 'Zoho Mail'
    except Exception:
        pass
    return None, None


# Global scheduler thread lock and control
scheduler_thread = None
scheduler_lock = threading.Lock()

def generate_backend_excel_report_bytes(config_input, target_status=None):
    """
    Generates an Excel workbook (.xlsx) as bytes containing real-time status of all campaign jobs,
    dispatched timestamps, assigned sender accounts, BCC lists, and failure error details.
    """
    try:
        import openpyxl
        from io import BytesIO
    except ImportError:
        return None

    config = {}
    if isinstance(config_input, str):
        if os.path.exists(config_input):
            try:
                with open(config_input, 'r', encoding='utf-8') as f:
                    config = json.load(f)
            except Exception:
                pass
    elif isinstance(config_input, dict):
        config = config_input

    recipients = config.get('recipients', [])
    wb = openpyxl.Workbook()

    failed_recipients = [r for r in recipients if str(r.get('status', '')).lower() == 'failed']

    if target_status and str(target_status).lower() == 'failed':
        # Sheet 1: Failed Jobs (Re-importable Format)
        ws1 = wb.active
        ws1.title = "Failed Emails (Re-importable)"
        ws1.append([
            'Name', 'Email', 'Affiliation', 'Sender Name', 'Account Email',
            'Template', 'S_Date', 'S_Time', 'CC', 'BCC', 'Action',
            'Status', 'Error Details', 'Recommended Action'
        ])

        target_list = failed_recipients if failed_recipients else recipients
        for r in target_list:
            err_msg = r.get('error', '')
            action_rec = "Keep python server.py window open" if "Relay Connection" in err_msg else ("Switch sender account or wait 24h" if "550" in err_msg or "limit" in err_msg.lower() else "Check 16-digit Google App Password")
            ws1.append([
                r.get('name', ''),
                r.get('email', ''),
                r.get('affiliation', ''),
                r.get('senderName', ''),
                r.get('sender', '') or r.get('senderEmail', ''),
                r.get('templateId', ''),
                r.get('rawSDate', '') or r.get('date', ''),
                r.get('rawSTime', '') or r.get('time', ''),
                r.get('cc', ''),
                r.get('bcc', ''),
                r.get('action', 'send'),
                r.get('status', 'Failed'),
                err_msg,
                action_rec
            ])

        # Sheet 2: Master Campaign Summary
        ws2 = wb.create_sheet(title="All Campaign Jobs")
        ws2.append(['Sr. No', 'Name', 'Email', 'CC', 'BCC', 'Sender Account', 'Template ID', 'Status', 'Dispatched At', 'Error Details'])
        for idx, r in enumerate(recipients, start=1):
            ws2.append([
                idx, r.get('name', ''), r.get('email', ''), r.get('cc', ''), r.get('bcc', ''),
                r.get('sender', ''), r.get('templateId', ''), r.get('status', 'Pending'),
                r.get('dispatchedAt', ''), r.get('error', '')
            ])
    else:
        # Sheet 1: Master Campaign Status
        ws1 = wb.active
        ws1.title = "Master Campaign Status"
        ws1.append([
            'Sr. No', 'Recipient Name', 'Recipient Email', 'CC', 'BCC Recipients',
            'Sender Account', 'Template ID', 'Scheduled Target Time',
            'Status', 'Dispatched At', 'Error Details / Failure Reason'
        ])

        filtered = recipients
        if target_status:
            filtered = [r for r in recipients if str(r.get('status', 'Pending')).lower() == str(target_status).lower()]

        for idx, r in enumerate(filtered, start=1):
            status_val = r.get('status', 'Pending')
            err_val = r.get('error', '')
            disp_time = r.get('dispatchedAt', '') or (r.get('parsedTime', '') if status_val in ('Sent', 'Failed') else '')

            ws1.append([
                idx,
                r.get('name', ''),
                r.get('email', ''),
                r.get('cc', ''),
                r.get('bcc', ''),
                r.get('sender', '') or r.get('senderEmail', ''),
                r.get('templateId', ''),
                r.get('parsedTime', '') or r.get('time', ''),
                status_val,
                disp_time,
                err_val
            ])

        if failed_recipients and not target_status:
            ws2 = wb.create_sheet(title="Failed Emails Only")
            ws2.append(['Name', 'Email', 'Affiliation', 'Sender Name', 'Account Email', 'Template', 'Status', 'Error Details', 'Recommended Action'])
            for r in failed_recipients:
                err_msg = r.get('error', '')
                action_rec = "Keep python server.py window open" if "Relay Connection" in err_msg else ("Switch sender account or wait 24h" if "550" in err_msg or "limit" in err_msg.lower() else "Check 16-digit Google App Password")
                ws2.append([
                    r.get('name', ''), r.get('email', ''), r.get('affiliation', ''), r.get('senderName', ''),
                    r.get('sender', ''), r.get('templateId', ''), 'Failed', err_msg, action_rec
                ])

    buffer = BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer.getvalue()

def save_backend_report_to_file(config):
    try:
        report_bytes = generate_backend_excel_report_bytes(config)
        if report_bytes:
            out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'latest_campaign_report.xlsx')
            with open(out_path, 'wb') as f:
                f.write(report_bytes)
    except Exception as e:
        print(f"[Backend Report] Error auto-saving latest_campaign_report.xlsx: {e}")

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
        """Handle health check requests, configuration GET, report download, and static files"""
        if self.path in ('/health', '/status', '/ping'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            response = {'success': True, 'status': 'healthy', 'message': 'SMTP Relay Server is active.'}
            self.wfile.write(json.dumps(response).encode('utf-8'))
        elif self.path.startswith('/api/export-report'):
            query_str = self.path.split('?')[1] if '?' in self.path else ''
            target_status = None
            if 'status=failed' in query_str.lower():
                target_status = 'Failed'
            elif 'status=sent' in query_str.lower():
                target_status = 'Sent'

            config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
            report_bytes = generate_backend_excel_report_bytes(config_path, target_status=target_status)

            if report_bytes:
                filename = f"Vesper_Campaign_{target_status or 'Full'}_Report.xlsx"
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(report_bytes)
            else:
                self.send_error_response("No campaign data found or Excel report generation failed", code=404)
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
                elif real_file_path.endswith('.xlsx'):
                    content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                elif real_file_path.endswith('.csv'):
                    content_type = 'text/csv; charset=utf-8'
                
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
                
                # Auto-update backend Excel report file
                save_backend_report_to_file(payload)
                try:
                    import sync_db
                    sync_db.sync_config_to_db()
                except Exception as db_err:
                    print(f"[DB Sync] Warning: {db_err}")

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

        if self.path == '/api/test-connection':
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

            success, msg = perform_connection_test(payload)
            self.send_json_response({'success': success, 'message': msg}, code=200)
            return

        if self.path != '/send':
            self.send_error_response("Endpoint not found. Use POST to /send or /api/test-connection", code=404)
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

    def send_json_response(self, data, code=200):
        body_bytes = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body_bytes)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body_bytes)

    def send_success_response(self, message='Email relayed successfully.'):
        self.send_json_response({'success': True, 'message': message}, code=200)

    def send_error_response(self, message, code=400):
        self.send_json_response({'success': False, 'message': message}, code=code)

def sanitize_display_name(raw_name, smtp_user=""):
    """Keep the Excel sender name, and never treat an account label or address as that name."""
    name = str(raw_name or "")
    name = name.replace("\xa0", " ").replace("\u200b", "").replace("\ufeff", "")
    name = re.sub(r"[\r\n\t]+", " ", name)
    name = re.sub(r"\s+", " ", name).strip().strip('"').strip("'").strip()
    if "<" in name and ">" in name:
        name = name.split("<", 1)[0].strip().strip('"').strip("'").strip()
    if not name:
        return ""
    user = str(smtp_user or "").strip().lower()
    if user and name.lower() == user:
        return ""
    # Labels created by this app, such as "gmail.com (parth.gkrf)", are not Excel sender names.
    if re.match(r"^[A-Za-z0-9.-]+\s*\([^)]+\)$", name) and "@" not in name:
        return ""
    return name


_pace_lock = threading.Lock()
PACE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pace_state.json')
GMAIL_DAILY_CAP = 400


def split_recipient_addresses(raw):
    parts = re.split(r'[,;\n]+', str(raw or ''))
    found = []
    seen = set()
    for part in parts:
        address = part.strip().strip('<>').strip()
        if '<' in address and '>' in address:
            address = address.split('<', 1)[1].split('>', 1)[0].strip()
        key = address.lower()
        if '@' in address and key not in seen:
            seen.add(key)
            found.append(address)
    return found


def configured_send_gap():
    try:
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
        with open(config_path, 'r', encoding='utf-8') as f:
            settings = json.load(f).get('settings', {})
        gap = float(settings.get('sendDelay') or 60)
    except Exception:
        gap = 60.0
    return max(30.0, min(gap, 300.0))


def _load_pace_state():
    if not os.path.exists(PACE_PATH):
        return {}
    try:
        with open(PACE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_pace_state(state):
    with open(PACE_PATH, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=2)


def wait_for_gmail_pace(account_email):
    """Space sends from one account so Gmail does not treat them as a burst."""
    key = str(account_email or '').strip().lower()
    gap = configured_send_gap()
    with _pace_lock:
        state = _load_pace_state()
        now = time.time()
        today = datetime.date.today().isoformat()
        rec = state.get(key) or {}
        if rec.get('day') != today:
            rec = {'day': today, 'count': 0, 'next': 0}
        if int(rec.get('count') or 0) >= GMAIL_DAILY_CAP:
            return False, (
                f"Stopped for {account_email}: {GMAIL_DAILY_CAP} emails already sent today. "
                "Waiting until tomorrow so Gmail does not block this account."
            )
        wait = max(0.0, float(rec.get('next') or 0) - now)
        upcoming = int(rec.get('count') or 0) + 1
        jitter = random.uniform(gap, gap * 1.5)
        extra = 180.0 if upcoming % 15 == 0 else 0.0
        rec['next'] = max(now, float(rec.get('next') or 0)) + jitter + extra
        rec['day'] = today
        state[key] = rec
        _save_pace_state(state)
    if wait > 0:
        print(f"    Gmail pace: waiting {wait:.0f}s before the next email from {account_email}")
        time.sleep(wait)
    return True, ""


def mark_gmail_pace_sent(account_email):
    key = str(account_email or '').strip().lower()
    with _pace_lock:
        state = _load_pace_state()
        today = datetime.date.today().isoformat()
        rec = state.get(key) or {'day': today, 'count': 0, 'next': 0}
        if rec.get('day') != today:
            rec = {'day': today, 'count': 0, 'next': rec.get('next', 0)}
        rec['count'] = int(rec.get('count') or 0) + 1
        rec['day'] = today
        state[key] = rec
        _save_pace_state(state)


def build_aligned_from(display_name, smtp_user):
    """From address must be the authenticated mailbox. Display name comes from Excel."""
    user = str(smtp_user or "").strip()
    name = sanitize_display_name(display_name, user)
    if name and user:
        # Gmail keeps this exact quoted form. An unquoted name, or a draft later
        # sent from the Gmail website, is replaced with the Google account name.
        safe = name.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{safe}" <{user}>', name
    return user, name


def clean_outbound_html(body):
    """Strip editor and forwarded-Gmail markup that spam filters treat as a relayed chain."""
    text = str(body or "")
    text = re.sub(r"\sfr-original-[\w:-]+=(\".*?\"|'.*?')", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"\sclass=(\"[^\"]*gmail_quote[^\"]*\"|'[^']*gmail_quote[^']*')", "", text, flags=re.IGNORECASE)
    text = re.sub(r"mailto:\s+", "mailto:", text, flags=re.IGNORECASE)
    return text


def html_to_plain_text(body):
    plain_text = re.sub(r"<br\s*/?>", "\n", body or "", flags=re.IGNORECASE)
    plain_text = re.sub(r"</p>", "\n\n", plain_text, flags=re.IGNORECASE)
    plain_text = re.sub(r"</(div|tr|li|h[1-6])>", "\n", plain_text, flags=re.IGNORECASE)
    plain_text = re.sub(r"<li[^>]*>", "- ", plain_text, flags=re.IGNORECASE)
    plain_text = re.sub(r"<[^>]+>", "", plain_text)
    plain_text = html.unescape(plain_text)
    plain_text = plain_text.replace("\xa0", " ")
    plain_text = re.sub(r"[ \t]+\n", "\n", plain_text)
    plain_text = re.sub(r"\n{3,}", "\n\n", plain_text).strip()
    if not plain_text:
        plain_text = "Please view this email in an HTML-compatible email client."
    return plain_text


def resolve_dispatch_action(settings):
    """Send vs draft is chosen only on the Configuration page."""
    settings = settings or {}
    method = str(settings.get('method') or '')
    local_action = str(settings.get('localAction') or '')
    if method == 'localserver_draft' or local_action == 'draft':
        return 'draft'
    return 'send'

def register_sent_email(recipient_email, sender_email=""):
    if not recipient_email:
        return
    clean_email = str(recipient_email).strip().lower()
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            sent_registry = config.get('sentRegistry', [])
            existing = set(e.strip().lower() for e in sent_registry if isinstance(e, str))
            if clean_email not in existing:
                sent_registry.append(clean_email)
                config['sentRegistry'] = sent_registry
                with open(config_path, 'w', encoding='utf-8') as f:
                    json.dump(config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[Sent Registry] Error updating sentRegistry: {e}")

def perform_email_dispatch(payload):
    action = payload.get('action', 'send')
    raw_host = payload.get('host')
    raw_port = payload.get('port')
    secure = payload.get('secure', 'ssl') # 'ssl', 'tls', or 'none'
    user = str(payload.get('user') or '').replace('\xa0', '').replace('\u200b', '').strip().strip('\'"')
    raw_pass = str(payload.get('pass') or '').replace('\xa0', '').replace('\u200b', '').strip()
    sender = payload.get('senderName') or payload.get('senderEmail')
    recipient = str(payload.get('recipientEmail') or payload.get('recipient') or '').replace('\xa0', '').replace('\u200b', '').strip()
    cc = payload.get('cc')
    bcc = payload.get('bcc')
    subject = payload.get('subject')
    body = payload.get('body')

    host, port = sanitize_smtp_host_and_port(raw_host, raw_port)
    password = sanitize_password(raw_pass)

    if not all([host, port, user, password, recipient, subject, body]):
        return False, f"Missing required SMTP fields (host: '{host}', port: '{port}', user: '{user}', recipientEmail: '{recipient}', subject, body)"

    print(f"\n>>> Incoming relay request for: {recipient}")
    if cc:
        print(f"    CC: {cc}")
    if bcc:
        print(f"    BCC: {bcc}")
    print(f"    SMTP Host: {host}:{port} (Security: {secure})")
    print(f"    SMTP User: {user}")

    try:
        # One person per message. A comma-separated cell must not become one shared email.
        recipient_list = split_recipient_addresses(recipient)
        if not recipient_list:
            return False, f"No valid recipient address in '{recipient}'"
        if len(recipient_list) > 1:
            sent = 0
            last_message = ""
            for address in recipient_list:
                one = dict(payload)
                one['recipientEmail'] = address
                success, last_message = perform_email_dispatch(one)
                if not success:
                    return False, last_message
                sent += 1
            return True, f"Sent {sent} individual emails."

        # From address is always the logged-in mailbox so SPF/DKIM align.
        # Display name is the Excel sender name, not the Google account name.
        msg = MIMEMultipart('alternative')
        sender_name = payload.get('senderName') or payload.get('sender') or ''
        from_header, clean_display_name = build_aligned_from(sender_name, user)
        msg['From'] = from_header
        msg['Reply-To'] = from_header
        print(f"    From: {from_header}")
            
        msg['To'] = recipient_list[0]
        recipient = recipient_list[0]
        if cc:
            msg['Cc'] = cc
            
        if subject:
            # Use RFC 2047 encoding for non-ASCII characters in Subject
            if any(ord(c) > 127 for c in subject):
                msg['Subject'] = Header(subject, 'utf-8').encode()
            else:
                msg['Subject'] = subject
        else:
            msg['Subject'] = ""

        # Headers a normal mailbox message carries. Campaign fingerprints
        # (X-Mailer, fake one-click unsubscribe) push mail into spam.
        msg['Date'] = email.utils.formatdate(localtime=True)
        domain_part = user.split('@')[1] if '@' in user else 'gmail.com'
        msg['Message-ID'] = email.utils.make_msgid(domain=domain_part)
        msg['List-Unsubscribe'] = f'<mailto:{user}?subject=unsubscribe>'

        safe_html = clean_outbound_html(body or '')
        plain_text = html_to_plain_text(safe_html)

        # Attach Plain Text first, then HTML (RFC 2046 requirement)
        msg.attach(MIMEText(plain_text, 'plain', 'utf-8'))
        msg.attach(MIMEText(safe_html, 'html', 'utf-8'))

        if action != 'draft':
            allowed, pace_message = wait_for_gmail_pace(user)
            if not allowed:
                print(f"    [Pace] {pace_message}")
                return False, pace_message

        # Setup Connection
        if action == 'draft':
            print(f"    Creating draft in IMAP server for {recipient}...")
            
            # For drafts, we want to include the Bcc header in the message so it saves correctly
            if bcc:
                msg['Bcc'] = bcc

            # Determine IMAP server
            imap_host = host
            if "smtp.gmail.com" in host or host == "gmail.com":
                imap_host = "imap.gmail.com"
            elif "smtp.mail.yahoo.com" in host or host == "yahoo.com":
                imap_host = "imap.mail.yahoo.com"
            elif "smtp.office365.com" in host or "smtp.live.com" in host or "outlook.com" in host:
                imap_host = "outlook.office365.com"
            elif host.startswith("smtp."):
                imap_host = host.replace("smtp.", "imap.")
            else:
                imap_host = f"imap.{host}"
            
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
            register_sent_email(recipient, user)
            return True, "Draft saved successfully."

        if secure == 'ssl':
            # SSL Connection (typically port 465)
            print(f"    Establishing secure SSL connection to {host}:{port}...")
            server = smtplib.SMTP_SSL(host, int(port), timeout=10)
        else:
            # Standard TCP connection (typically port 587 or 25)
            print(f"    Establishing standard connection to {host}:{port}...")
            server = smtplib.SMTP(host, int(port), timeout=10)
            if secure == 'tls':
                # Start TLS handshake (STARTTLS)
                print("    Upgrading connection via STARTTLS...")
                server.starttls()

        envelope_recipients = [recipient]
        if cc:
            envelope_recipients.extend(split_recipient_addresses(cc))
        if bcc:
            envelope_recipients.extend(split_recipient_addresses(bcc))

        # Authenticate and send
        print("    Logging into SMTP server...")
        server.login(user, password)
        
        print(f"    Sending individual email to {recipient}...")
        server.sendmail(user, envelope_recipients, msg.as_bytes())
        
        # Close connection cleanly
        server.quit()
        mark_gmail_pace_sent(user)
        print("    Transaction completed successfully!\n")
        register_sent_email(recipient, user)
        return True, "Email relayed successfully."

    except smtplib.SMTPAuthenticationError:
        rec_host, provider_name = check_domain_mx_provider(host)
        if provider_name or 'gmail' in host.lower() or 'google' in host.lower() or 'gmail' in user.lower():
            err_msg = f"SMTP Authentication failed for account '{user}'. For Gmail/Google Workspace, ensure 2-Step Verification is ON and a 16-digit App Password is used without spaces."
        else:
            err_msg = f"SMTP Authentication failed for account '{user}'. Please check username and password."
        print(f"    [Error] {err_msg}")
        return False, err_msg
    except (socket.gaierror, socket.herror) as e:
        rec_host, provider_name = check_domain_mx_provider(host)
        if rec_host:
            err_msg = f"SMTP Host '{host}' does not exist in DNS ([Errno 11001]). Provider Detected: Domain uses {provider_name}! Please change your SMTP Host to '{rec_host}' in Account Settings (Port 465 SSL or 587 TLS)."
        else:
            err_msg = f"SMTP Transmission failure: [Errno 11001] getaddrinfo failed for host '{host}'. DNS could not resolve server address. Please verify your SMTP Host in Account Settings (e.g. 'smtp.gmail.com')."
        print(f"    [Error] {err_msg}")
        return False, err_msg
    except socket.timeout:
        err_msg = f"SMTP Connection to '{host}:{port}' timed out. Please check your server hostname, port ({port}), network connection, or firewall settings."
        print(f"    [Error] {err_msg}")
        return False, err_msg
    except smtplib.SMTPConnectError as e:
        err_msg = f"SMTP Connection to '{host}:{port}' failed: {str(e)}. Please check port number and security settings (SSL vs TLS)."
        print(f"    [Error] {err_msg}")
        return False, err_msg
    except Exception as e:
        err_str = str(e)
        if "11001" in err_str or "getaddrinfo failed" in err_str or "Name or service not known" in err_str:
            rec_host, provider_name = check_domain_mx_provider(host)
            if rec_host:
                err_msg = f"SMTP Host '{host}' does not exist in DNS. Provider Detected: Domain uses {provider_name}! Please change your SMTP Host to '{rec_host}' in Account Settings."
            else:
                err_msg = f"SMTP Transmission failure: [Errno 11001] getaddrinfo failed for host '{host}'. DNS could not resolve server address. Please verify your SMTP Host in Account Settings."
        else:
            err_msg = f"SMTP Transmission failure: {err_str}"
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
            "{Sender Name}": r.get('senderName') or r.get('sender_name') or r.get('sender', ''),
            "{Sender}": r.get('senderName') or r.get('sender_name') or r.get('sender', ''),
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
    acc = None
    if sender_accounts:
        # 1. Direct recipient account ID
        acc_id = rec.get('senderAccountId')
        if acc_id:
            for a in sender_accounts:
                if a.get('id') == acc_id:
                    acc = a
                    break
        # 2. Recipient sender string / email match
        if not acc:
            rec_sender = (rec.get('sender') or rec.get('senderEmail') or '').strip().lower()
            if rec_sender:
                if '<' in rec_sender and '>' in rec_sender:
                    rec_sender = rec_sender.split('<')[1].split('>')[0].strip().lower()
                for a in sender_accounts:
                    user_val = (a.get('user') or '').strip().lower()
                    label_val = (a.get('label') or '').strip().lower()
                    if user_val == rec_sender or label_val == rec_sender:
                        acc = a
                        break
        # 3. Template account ID
        if not acc and job_template.get('senderAccountId'):
            for a in sender_accounts:
                if a.get('id') == job_template.get('senderAccountId'):
                    acc = a
                    break
        # 4. Default account
        if not acc:
            for a in sender_accounts:
                if a.get('isDefault'):
                    acc = a
                    break
        # 5. Fallback to first account
        if not acc and sender_accounts:
            acc = sender_accounts[0]

    if not acc:
        return False, "No sender account configured for " + (rec.get('sender') or 'this job') + "."

    def get_final_sender_name(r, account):
        smtp_user = (account or {}).get('user') or ''
        if r:
            sender_name = sanitize_display_name(r.get('senderName') or '', smtp_user)
            if sender_name:
                return render_template(sender_name, r)
            for k in ['Sender Name', 'Sender name', 'sender_name', 'From Name', 'FromName', 'Display Name']:
                candidate = sanitize_display_name(r.get(k) or '', smtp_user)
                if candidate:
                    return render_template(candidate, r)
            sender = str(r.get('sender') or '').strip()
            if sender and '<' in sender and '>' in sender:
                name_part = sanitize_display_name(sender, smtp_user)
                if name_part:
                    return render_template(name_part, r)
            elif sender and ('@' not in sender or ' ' in sender):
                candidate = sanitize_display_name(sender, smtp_user)
                if candidate:
                    return render_template(candidate, r)
        return ""

    final_sender_name = get_final_sender_name(rec, acc)
    dispatch_action = resolve_dispatch_action(settings)

    payload = {
        'action': dispatch_action,
        'host': acc.get('host'),
        'port': acc.get('port'),
        'secure': acc.get('secure', 'ssl'),
        'user': acc.get('user'),
        'pass': acc.get('pass'),
        'senderName': final_sender_name,
        'senderEmail': acc.get('user'),
        'recipientName': rec.get('name') or '',
        'recipientEmail': rec.get('email'),
        'cc': rec.get('cc') or '',
        'bcc': rec.get('bcc') or '',
        'subject': subject,
        'body': body
    }

    return perform_email_dispatch(payload)



def parse_iso_time(iso_str):
    if not iso_str:
        return None
    try:
        clean_str = str(iso_str).strip()
        if 'Z' in clean_str or '+' in clean_str or (clean_str.count('-') >= 2 and 'T' in clean_str):
            # Parse with timezone
            dt_utc = datetime.datetime.fromisoformat(clean_str.replace('Z', '+00:00'))
            # Convert to local datetime
            return datetime.datetime.fromtimestamp(dt_utc.timestamp())
        else:
            clean_str = clean_str.split('.')[0].replace('T', ' ')
            return datetime.datetime.strptime(clean_str, '%Y-%m-%d %H:%M:%S')
    except Exception:
        return None

def background_scheduler_loop():
    global scheduler_thread
    print("[Background Scheduler] Loop started with strict Date/Time verification & Sent Registry Protection.")
    
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
        sent_registry_list = config.get('sentRegistry', [])
        sent_registry = set(email.strip().lower() for email in sent_registry_list if isinstance(email, str))
        
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

        # Dispatch due jobs with strict date/time matching & duplicate sent lock
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

            job_key = rec.get('id') or f"{rec.get('name')}_{rec.get('rawSDate')}_{rec.get('email')}"
            
            # 1. STRICT DUPLICATE GUARD: Verify if this job was already sent previously
            if job_key and job_key in sent_registry:
                print(f"[Background Scheduler] [Sent Guard] {rec.get('name')} ({rec.get('email')}) [Job: {job_key}] was ALREADY SENT. Skipping dispatch.")
                rec['status'] = 'Sent'
                rec['error'] = 'Already sent previously (Duplicate Protection Guard)'
                try:
                    with open(config_path, 'w', encoding='utf-8') as f:
                        json.dump(config, f, indent=2, ensure_ascii=False)
                except Exception:
                    pass
                continue

            # 2. STRICT DATE/TIME MATCHING GUARD
            parsed_time_str = rec.get('parsedTime')
            parsed_time = parse_iso_time(parsed_time_str) if parsed_time_str else None
            
            # DO NOT SEND if schedule date/time is missing, invalid, or in the FUTURE!
            if not parsed_time:
                # Missing or invalid timestamp: do NOT shoot automatically!
                continue

            if now < parsed_time:
                # Scheduled date and time has NOT arrived yet! Wait until exact time match.
                continue

            # Date and time MATCHED! Proceed with safe dispatch
            target_account_email = rec.get('sender') or 'default account'
            print(f"[Background Scheduler] [Date/Time Matched] Dispatching email to {rec.get('name')} ({rec.get('email')}) at {now.strftime('%Y-%m-%d %H:%M:%S')}. Scheduled target was: {parsed_time.strftime('%Y-%m-%d %H:%M:%S')}")
            rec['status'] = 'Sending'
            try:
                with open(config_path, 'w', encoding='utf-8') as f:
                    json.dump(config, f, indent=2, ensure_ascii=False)
            except Exception:
                pass
                
            success, error_msg = send_email_backend(rec, settings, templates, active_template_id)
            dispatch_action = resolve_dispatch_action(settings)
            
            rec['dispatchedAt'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            rec['action'] = dispatch_action
            if success:
                rec['status'] = 'Drafted' if dispatch_action == 'draft' else 'Sent'
                if 'error' in rec:
                    del rec['error']
                if job_key:
                    sent_registry.add(job_key)
                    config['sentRegistry'] = list(sent_registry)
                print(f"[Background Scheduler] Success: Sent to {rec.get('name')} ({rec.get('email')})")
            else:
                rec['status'] = 'Failed'
                rec['error'] = error_msg
                print(f"[Background Scheduler] Failed: {rec.get('name')} - {error_msg}")
                
            try:
                with open(config_path, 'w', encoding='utf-8') as f:
                    json.dump(config, f, indent=2, ensure_ascii=False)
                save_backend_report_to_file(config)
            except Exception as e:
                print(f"[Background Scheduler] Error saving state: {e}")
                
            # The send itself already waits out the Gmail gap. Don't add a second delay.
            time.sleep(1.0)
            
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

def is_port_free(p):
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', p))
        s.close()
        return True
    except OSError:
        return False

if __name__ == '__main__':
    # Parse port argument if provided
    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port argument '{sys.argv[1]}'. Using default {PORT}.", flush=True)

    server = None
    while True:
        if not is_port_free(port):
            print(f"Port {port} is occupied on 127.0.0.1. Trying next port {port + 1}...", flush=True)
            port += 1
            if port > 3100:
                print("Could not find an available port between 3000 and 3100.", flush=True)
                sys.exit(1)
            continue
        try:
            server = ThreadingHTTPServer(('0.0.0.0', port), SMTPRelayHandler)
            break
        except OSError as e:
            # Check for address already in use (EADDRINUSE / WinError 10048)
            print(f"Port {port} is occupied. Trying next port {port + 1}...", flush=True)
            port += 1
            if port > 3100:  # limit search range to avoid infinite loop
                print("Could not find an available port between 3000 and 3100.", flush=True)
                sys.exit(1)

    print("=" * 60, flush=True)
    print("           VESPER MAIL SCHEDULER SMTP RELAY SERVER          ", flush=True)
    print("=" * 60, flush=True)
    print(f"Starting server on port {port}...", flush=True)
    print(f"Web UI available at: http://localhost:{port}", flush=True)
    print(f"Relay listening at:  http://localhost:{port}/send", flush=True)
    print("Keep this window open to run the scheduler and process emails.", flush=True)
    print("Press Ctrl+C to terminate.", flush=True)
    print("-" * 60, flush=True)

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
