import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ComfyClient } from "../src/main/core/comfy.ts"
const c = new ComfyClient("127.0.0.1", 8188)
const dest = path.join(os.tmpdir(), "h3_三采_验证.mp4")
await c.download("三采_N471_0001.mp4", "", "output", dest)
const st = await fsp.stat(dest)
console.log("下载验证成功:", dest, st.size, "bytes")
