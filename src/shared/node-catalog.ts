/**
 * 工作流节点包（工作流节点包）功能域目录。
 *
 * 用途：在设置页给用户一张「这个节点包能做什么、镜序工坊覆盖到哪一步」的总览，
 * 便于按需取舍。数据来源见 docs/工作流节点包功能分析与重现蓝图.md。
 *
 * status 语义：
 *   'ui'       —— 已在镜序工坊做成可视化控件（本软件内可调）
 *   'backend'  —— 由 ComfyUI 后端执行，软件发参数收产物（不需要在软件里重写）
 *   'template' —— 通过导入/切换对应工作流模板使用（设置页导入）
 */

export type NodeCapabilityStatus = 'ui' | 'backend' | 'template'

export interface NodeCapability {
  /** 代表节点 class_type（可能多个用 / 分隔） */
  node: string
  /** 中文功能名 */
  label: string
  /** 一句话说明 */
  desc: string
  status: NodeCapabilityStatus
  /** 在软件哪里用 */
  where: string
}

export interface NodeDomain {
  id: string
  label: string
  icon: string
  desc: string
  items: NodeCapability[]
}

export const NODE_DOMAINS: NodeDomain[] = [
  {
    id: 'csglide',
    label: '导演台 · 分镜链',
    icon: 'clapperboard',
    desc: '把 ComfyUI 网页端的人工操作搬进软件的核心：媒体架 → 文案台 → 导演台三份契约。',
    items: [
      { node: 'CSGlideH3MediaRackCS', label: '媒体架', desc: '选参考图/视频/音频，按槽位编号绑定', status: 'ui', where: '导演台 → 参考图绑定面板' },
      { node: 'CSGlideDeskCS', label: '文案台', desc: '片子级 + 本段提示词、presets 快捷短语', status: 'ui', where: '导演台 → 文案台面板' },
      { node: 'CSGlideCastCS', label: '导演台', desc: '画布/帧数/续接/钉帧/语义桥，编码成 conditioning', status: 'ui', where: '导演台 → 分段导演 + 段参数' },
      { node: 'BanZhang_H3_ClipArchive', label: '片段存档', desc: '潜空间续拍存档，段间衔接', status: 'backend', where: '导演台 → 续接开关（自动登记）' },
      { node: 'CSGlideJoinCS / SeedCS / TailRefCS', label: '续接/取种/尾帧', desc: '分镜链续接与段尾归位', status: 'backend', where: '工作流内自动执行' }
    ]
  },
  {
    id: 'upscale',
    label: '放大超分',
    icon: 'maximize',
    desc: '潜空间放大 / RTX 超分 / 高清化。',
    items: [
      { node: 'BanZhang_MMH3_Upscale / UpscaleParams', label: 'H3 潜空间放大', desc: '倍数/目标尺寸/分块/显存预设', status: 'ui', where: '导演台 → 段参数 → 放大重绘' },
      { node: 'BanZhang_RTX_SuperResolution', label: 'RTX 超分', desc: '处理档位/像素精度/封装', status: 'ui', where: '导演台 → 节点参数 → RTX 超分' },
      { node: 'BanZhang_SelfLiftMultiStage', label: 'SelfLift 多级', desc: '分段步数/级间倍率/token 分块', status: 'ui', where: '导演台 → 节点参数 → SelfLift' },
      { node: 'BanZhang_ImageHiResUpscale', label: '图片高清放大', desc: '资产生图链里的 2× 放大', status: 'backend', where: '资产 → 生成图模板内自动执行' }
    ]
  },
  {
    id: 'interp',
    label: '插帧',
    icon: 'fast-forward',
    desc: '视频补帧。',
    items: [
      { node: 'BanZhang_RIFE_Interpolation', label: 'RIFE 插帧', desc: '2/4/8 倍插帧，保留原音', status: 'ui', where: '导演台 → 段参数 → 抽帧/插帧' },
      { node: 'BanZhang_RTX_FrameGeneration', label: 'RTX 帧生成', desc: '显卡插帧', status: 'backend', where: '需导入对应工作流模板' }
    ]
  },
  {
    id: 'h3sampling',
    label: 'H3 采样 / VAE / 显存',
    icon: 'cpu',
    desc: '采样调度、快速 VAE 解码与显存优化。',
    items: [
      { node: 'BanZhang_SLABlockSparseAttention', label: '稀疏注意力 SLA', desc: '跳过后段部分注意力，提速', status: 'ui', where: '导演台 → 节点参数 → SLA' },
      { node: 'BanZhang_H3MemoryOptimizer', label: 'H3 显存优化', desc: '前馈分块/头分组', status: 'ui', where: '导演台 → 节点参数 → 显存优化' },
      { node: 'BanZhang_H3VAEDecodeFast', label: '快速 VAE 解码', desc: '时间分块/帧流', status: 'backend', where: '工作流内自动执行' },
      { node: 'MiniMaxH3SigmaShift', label: 'Sigma 位移', desc: '视频/音频噪声调度位移', status: 'ui', where: '导演台 → 节点参数 → Sigma' },
      { node: 'MiniMaxH3PreviewOverride', label: '预览覆盖', desc: '预览分辨率/帧率/画质', status: 'ui', where: '导演台 → 节点参数 → 预览' }
    ]
  },
  {
    id: 'vram',
    label: '显存管理',
    icon: 'gauge',
    desc: '显存守卫、净化与监视。',
    items: [
      { node: 'BanZhang_VRAM_Guard / Cleaner', label: '守卫 / 净化', desc: '预留容量、出片后卸载模型', status: 'ui', where: '导演台 → 节点参数 → 显存守卫' },
      { node: 'BanZhang_Mem_Graph', label: '显存监视器', desc: '画布显示显存曲线', status: 'backend', where: 'ComfyUI 网页端可见，不影响生成' },
      { node: 'BanZhang_LoRA_VramSafe', label: 'LoRA 安全挂载', desc: '多 LoRA 一次挂载', status: 'ui', where: '导演台 → 节点参数 → LoRA 多挂载' }
    ]
  },
  {
    id: 'video',
    label: '视频合成输出',
    icon: 'film',
    desc: '封装、格式与提示音。',
    items: [
      { node: 'banzhangVideoCombine', label: '视频合成', desc: '帧率/MP4/H265/GIF/提示音/出片净化', status: 'ui', where: '导演台 → 节点参数 → 视频合成输出' },
      { node: 'BanZhang_SceneDetectSplit', label: '场景切割', desc: '按镜头切分视频', status: 'template', where: '导入对应工作流模板' }
    ]
  },
  {
    id: 'text',
    label: '文本 / 字幕 / 音频 / 乐谱',
    icon: 'music',
    desc: '字幕、配乐与智能乐谱。',
    items: [
      { node: 'ACE Step 1.5', label: 'ACE 音乐生成', desc: '标签化音乐生成', status: 'template', where: '导入「ACE 音乐生成」模板' },
      { node: 'BanzhangYuE2SmartPlan / LyricsInput', label: 'YuE2 智能乐谱', desc: '歌词/风格/ABC 乐谱', status: 'template', where: '导入「YuE2 智能乐谱」模板' },
      { node: 'BanZhang_Subtitle*', label: '字幕工具', desc: '字幕生成与烧录', status: 'template', where: '导入对应工作流模板' }
    ]
  },
  {
    id: 'image',
    label: '图片 API / 加载器 / 工具',
    icon: 'image',
    desc: '素材加载、宫格切分与图片生成。',
    items: [
      { node: 'BanzhangVisualLoader', label: '视觉加载器', desc: '按文件夹/排序加载素材', status: 'backend', where: '工作流内自动执行' },
      { node: 'UnifiedBanana2', label: '图片 API', desc: '第三方图片生成接口', status: 'template', where: '导入对应工作流模板' },
      { node: 'Z-Image / Krea2 / 千问 Image', label: '资产生图', desc: '文生图/四视图/图像编辑', status: 'template', where: '资产 → 生成图（选模板）' }
    ]
  }
]

export const STATUS_LABEL: Record<NodeCapabilityStatus, string> = {
  ui: '软件内可调',
  backend: '后端自动',
  template: '导入模板'
}
