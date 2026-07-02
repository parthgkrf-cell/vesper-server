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
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

PORT = 3000

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
        """Handle health check requests"""
        if self.path in ('/health', '/status', '/ping'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            response = {'success': True, 'status': 'healthy', 'message': 'SMTP Relay Server is active.'}
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_error_response("Endpoint not found. Use GET /health or POST /send", code=404)

    def do_POST(self):
        """Relay SMTP requests"""
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

        # Extract fields
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
            self.send_error_response("Missing required SMTP fields (host, port, user, pass, recipientEmail, subject, body)")
            return

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
            msg['From'] = f"{sender} <{user}>" if sender else user
            msg['To'] = recipient
            if cc:
                msg['Cc'] = cc
            msg['Subject'] = subject
            
            # Format text body (supports standard text content)
            msg.attach(MIMEText(body, 'plain', 'utf-8'))

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
                self.send_success_response()
                return

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
            
            self.send_success_response()

        except smtplib.SMTPAuthenticationError:
            err_msg = "SMTP Authentication failed. Please check your username and password/app-specific password."
            print(f"    [Error] {err_msg}")
            self.send_error_response(err_msg)
        except Exception as e:
            err_msg = f"SMTP Transmission failure: {str(e)}"
            print(f"    [Error] {err_msg}")
            self.send_error_response(err_msg)

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
    print(f"Relay listening at: http://localhost:{port}/send")
    print("Keep this window open to process local SMTP background queue.")
    print("Press Ctrl+C to terminate.")
    print("-" * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down SMTP Relay server. Goodbye.")
        sys.exit(0)
