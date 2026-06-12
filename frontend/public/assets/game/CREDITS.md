# 电波赛博像素割草小游戏公开数据 Credits

本目录是 Hoshia Live Room 的公开小游戏数据包，用于演示「电波赛博像素割草」玩法的职业、导演规则、升级三选一配置与像素视觉资源索引。

## 内容来源

- 游戏设定、职业名称、数值字段、Hoshia mood/activity 映射：为本项目新增的原创公开配置。
- 成熟公开素材（优先来源）：本轮优先使用 Kenney 的 CC0 公开素材包作为通用地形、顶视图单位参考与粒子/特效来源，并重新裁切、缩放、调色、重组成项目图集。
- 项目补齐素材：Hoshia 主角、10 个职业头像、职业图标、敌人/BOSS 主题映射、霓虹爆散命名与部分像素帧由项目按 Hoshia Live Room 主题补绘。
- Cainos / itch.io 素材：本轮未将 Cainos、itch.io 或其他授权不确定/限制再分发素材包的原始图片、图集、切片、工程文件加入本目录。
- 运行时私有数据：无。

## 第三方公开素材

### Kenney Tiny Dungeon

- Files used/derived: `sprites/atlases/biomes.v1.png`, `sprites/previews/biomes/*.png`
- Source type: Public mature asset, CC0
- Author: Kenney
- Source URL: https://kenney.nl/assets/tiny-dungeon
- License: Creative Commons CC0 / public domain
- Retrieved date: 2026-06-13
- Changes: selected tiles, resized, recolored/tinted, composited into Hoshia cyber-radio biome previews and atlas frames.
- Attribution required: no, included for clarity.

### Kenney Top-down Shooter

- Files used/derived: `sprites/atlases/biomes.v1.png`, `sprites/previews/biomes/*.png`
- Source type: Public mature asset, CC0
- Author: Kenney
- Source URL: https://kenney.nl/assets/top-down-shooter
- License: Creative Commons CC0 / public domain
- Retrieved date: 2026-06-13
- Changes: selected tiles, resized, recolored/tinted, composited into Hoshia cyber-radio biome previews and atlas frames.
- Attribution required: no, included for clarity.

### Kenney Particle Pack

- Files used/derived: `sprites/atlases/combat.v1.png`
- Source type: Public mature asset, CC0
- Author: Kenney
- Source URL: https://kenney.nl/assets/particle-pack
- License: Creative Commons CC0 / public domain
- Retrieved date: 2026-06-13
- Changes: used as visual reference/source category for neon impact and burst effects; final atlas frames are resized/recolored/recomposed for the project.
- Attribution required: no, included for clarity.

## 项目原创 / 补齐素材

- Files: `sprites/atlases/actors.v1.png`, `sprites/atlases/ui-icons.v1.png`, `sprites/portraits/**`
- Source type: Project original / procedural pixel drawing / project-specific adaptation
- Author: Hoshia Live Room project
- License: Project-owned asset
- Notes: Hoshia 角色遵循本项目已有角色设定：白发猫耳、蓝白偶像服、紫眼、耳麦、钥匙/肉球元素。

## 后续引入规则

- 如果未来某个文件不是项目原创或 Kenney CC0 衍生，必须在入仓时同步更新本 Credits。
- 第三方素材必须优先选择 CC0；无法确认公开商用与再分发授权时不得入仓。
- 不要把素材下载缓存、源工程临时文件或未清理的外部素材包整体提交到本目录。

## 安全说明

- 本数据包只包含公开玩法文本、数值、公开素材和项目像素资源。
- 不包含本地绝对路径、凭据、服务器地址或私有部署信息。
- 如果后续接入模块事件或记忆系统，请只写入短文本白名单字段，并把用户行为提纯为偏好摘要。

## 面向外行的说明

这批文件相当于小游戏的「公开规则表 + 公开美术包」：玩家能选哪些职业、Hoshia 当前心情会怎样影响关卡节奏、升级时会出现哪三张卡，以及游戏里角色、怪物、场景、特效长什么样，都在这里公开记录来源和用途。
