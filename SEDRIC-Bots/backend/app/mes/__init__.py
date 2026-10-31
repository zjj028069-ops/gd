"""MES mode: lets SEDRIC01 (赛德瑞克 MES) users operate the factory system by chat.

Safety model (read this before changing anything here):
- A MES session can only use the tools in `mes.tools.MES_TOOLS` plus `clarify`.
  Terminal, files, web, MCP, skills, memory, cron and bot-to-bot messaging are
  never offered, whatever the bot profile says.
- Every MES tool calls one fixed SEDRIC01 API path on a fixed base URL, using
  the logged-in user's own session. The bot can never do more than that user
  could do in the normal UI, and the model cannot pick URLs or paths.
- Every write asks the user to confirm in the chat before it is sent.
- The gateway (`mes.gateway`) only accepts calls from the SEDRIC01 API, which
  proves itself with a shared secret and passes the user's identity.
"""

MES_BOT = "sedric-mes"
