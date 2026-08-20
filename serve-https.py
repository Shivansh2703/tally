#!/usr/bin/env python3
"""Serve this folder over https so a phone on the same wifi can use the microphone.

Browsers only give getUserMedia to a secure context: https, or localhost. A phone
loading http://<mac-ip>:8000 gets no microphone at all — hence this.

    python3 serve-https.py

Generates a self-signed cert on first run and prints the URL to open. The cert and
its private key live in ~/.tally-devcert, deliberately OUTSIDE this folder — a
plain directory server hands out every file it can see, and the private key is not
something to put on the wifi. Nothing is published anywhere; this is your machine
on your network.
"""
import http.server, ipaddress, os, socket, ssl, subprocess, sys

PORT = 8443
CERT_DIR = os.path.expanduser("~/.tally-devcert")
CERT = os.path.join(CERT_DIR, "cert.pem")
KEY = os.path.join(CERT_DIR, "key.pem")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))   # no packet is actually sent
        return s.getsockname()[0]
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERT_DIR, mode=0o700, exist_ok=True)
    if os.path.exists(CERT) and os.path.exists(KEY):
        # regenerate if this machine's address has changed since last time
        out = subprocess.run(["openssl", "x509", "-in", CERT, "-noout", "-ext", "subjectAltName"],
                             capture_output=True, text=True).stdout
        if f"IP Address:{ip}" in out:
            return
        print("LAN address changed since the last certificate — regenerating.")
    print(f"generating a self-signed certificate for {ip} ...")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY, "-out", CERT, "-days", "365",
        "-subj", "/CN=tally-dev",
        "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost",
    ], check=True)
    os.chmod(KEY, 0o600)


if __name__ == "__main__":
    ip = lan_ip()
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        sys.exit(f"could not work out this machine's LAN address (got {ip!r})")

    ensure_cert(ip)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)

    httpd = http.server.HTTPServer(("0.0.0.0", PORT), http.server.SimpleHTTPRequestHandler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"\n  on this Mac:   https://localhost:{PORT}")
    print(f"  on your phone: https://{ip}:{PORT}")
    print(f"\n  cert: {CERT}  (airdrop this to the phone if Safari won't let the mic through)\n")
    print("  Safari will warn about the certificate — expected for a self-signed one.")
    print("  See README, 'Running it on your phone'.\n")
    httpd.serve_forever()
