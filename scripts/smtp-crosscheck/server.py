"""An INDEPENDENT SMTP server for cross-checking the CRM's client.

aiosmtpd, not the sink that ships beside the client — a bug the client and its own
test double share is invisible to tests that use only the double, which the agent
that wrote them said in as many words.
"""
import asyncio, json, sys, base64
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import SMTP, AuthResult, LoginPassword

received = []

class Handler:
    async def handle_DATA(self, server, session, envelope):
        received.append({
            "mail_from": envelope.mail_from,
            "rcpt_tos": list(envelope.rcpt_tos),
            "raw": envelope.content.decode("utf8", "replace"),
        })
        return "250 Message accepted for delivery"

def authenticator(server, session, envelope, mechanism, auth_data):
    if isinstance(auth_data, LoginPassword):
        u = auth_data.login.decode(); p = auth_data.password.decode()
        if u == "crmuser" and p == "s3cret-pass":
            return AuthResult(success=True)
    return AuthResult(success=False, handled=False)

class Factory:
    def __init__(self, require_auth): self.require_auth = require_auth
    def __call__(self):
        return SMTP(Handler(), enable_SMTPUTF8=True, decode_data=False,
                    authenticator=authenticator if self.require_auth else None,
                    auth_required=self.require_auth, auth_require_tls=False)

async def main():
    require_auth = "--auth" in sys.argv
    loop = asyncio.get_running_loop()
    server = await loop.create_server(Factory(require_auth), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    print(json.dumps({"port": port}), flush=True)
    async with server:
        # Report each message as it lands so the Node side can assert on it.
        seen = 0
        while True:
            await asyncio.sleep(0.05)
            while seen < len(received):
                print(json.dumps({"message": received[seen]}), flush=True)
                seen += 1

asyncio.run(main())
