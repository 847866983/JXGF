@echo off
cd /d "D:\¾µÐò¹¤·»"
set ELECTRON_RUN_AS_NODE=
if not exist "D:\¾µÐò¹¤·»\logs" mkdir "D:\¾µÐò¹¤·»\logs"
"C:\Users\84786\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "C:\Users\84786\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" dev >> "D:\¾µÐò¹¤·»\logs\dev.log" 2>&1