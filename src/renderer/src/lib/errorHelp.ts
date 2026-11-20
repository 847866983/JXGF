/** 把 ComfyUI / 生成流程的原始错误翻译成「中文原因 + 处理建议」 */

export interface ErrorHelp {
  reason: string
  suggestion: string
}

export function explainError(raw: string | null | undefined): ErrorHelp | null {
  if (!raw) return null
  const m = raw.toLowerCase()

  // 显存不足
  if (/out of memory|oom|allocation on device|cuda.*memory|cublas_status_alloc|显存/.test(m)) {
    return {
      reason: '显存不足（模型太大 / 分辨率太高）',
      suggestion: '降低分辨率或生成档位（如 512×288、更少帧数），关闭其它占显存的程序后重试；或换更小的模型版本。'
    }
  }
  // 节点缺失 —— 必须排在「找不到文件」前面：
  // `Node 'Label (rgthree)' not found` 也含 "not found"，先匹配模型会把节点错误
  // 误报成「缺少模型」，把人带到错误的方向。
  if (
    /missing_node_type|node.*not found|unknown node|class_type.*not found|missing node|cannot import|failed to import|no module named/.test(m)
  ) {
    return {
      reason: '缺少节点/插件（工作流用到的自定义节点没装，或是纯界面节点被误提交）',
      suggestion: '自定义节点缺失：把对应节点包放进 ComfyUI/custom_nodes 后重启 ComfyUI。若提示的是 Label/Reroute/Note 这类界面节点，属于转换问题，更新软件即可。'
    }
  }
  // 找不到模型/文件
  if (/value not in list|no such file|cannot find|file.*does not exist|missing.*(model|safetensors|ckpt)|model.*not found/.test(m)) {
    return {
      reason: '缺少模型或文件（工作流引用的模型不在 ComfyUI 里）',
      suggestion: '确认 ComfyUI 的 models 目录里放对了文件（注意子目录层级要和模型名一致），或在设置里检查模型路径后重试。'
    }
  }
  // 续拍存档 / 链式登记
  if (/续拍存档|登记当前段|h3_context/.test(raw)) {
    return {
      reason: 'H3 续拍存档未登记',
      suggestion: '这是链式续接节点要求。重试一次通常会自动登记；仍失败请确认工作流含 CSGlideCastCS 且工程名正确。'
    }
  }
  // 调度器/参数非法
  if (/invalid scheduler|scheduler.*invalid|calculate_sigmas|bong_tangent/.test(m)) {
    return {
      reason: '采样器/调度器参数不被支持',
      suggestion: '把调度器改成 simple、采样器改成 euler（或在工作流参数里调整）后重试。'
    }
  }
  // 除零（放大重绘参数非法）
  if (/division by zero|zero division|除以零|denoise.*0/i.test(m)) {
    return {
      reason: '放大重绘参数非法（去噪强度/步数为 0，导致除零）',
      suggestion: '在「导演台 → 段参数 → 放大重绘」里把「去噪强度」设为 0.05 以上、「重绘步数」≥1 后重试；这是已知问题，新版已自动修正。'
    }
  }
  // SelfLift 分段步数
  if (/分段步数|selflift|超过本次调度/.test(raw)) {
    return {
      reason: 'SelfLift 分段步数与采样步数不一致',
      suggestion: '把采样步数调成偶数（如 4/6/8），系统会自动对齐分段步数；或调低步数后重试。'
    }
  }
  // 连接/网络
  if (/econnrefused|fetch failed|connect.*refused|network|timeout|超时|无法连接/.test(m)) {
    return {
      reason: '连接 ComfyUI 失败（可能没启动或地址/端口不对）',
      suggestion: '确认 ComfyUI 已启动且在运行（设置 → 环境检测 → 内置 ComfyUI 启动），检查地址端口后重试。'
    }
  }
  // 上传参考图
  if (/参考图|upload.*image|uploadimage/.test(m)) {
    return {
      reason: '参考图上传失败',
      suggestion: '确认资产已绑定图片、文件未被删除；重试一次；仍失败可先取消该资产的引用再生成。'
    }
  }
  return {
    reason: '生成失败',
    suggestion: '可点「重试」再跑一次；若持续失败，展开下方原始错误查看具体节点，或降低参数后重试。'
  }
}
