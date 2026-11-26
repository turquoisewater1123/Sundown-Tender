# Sundown Tender · 夜读

Windows 电脑运行服务，手机用浏览器或 Android 客户端访问。仓库包含夜读前后端、Android Java 源码和可安装 APK、六个示例剧本、状态卡扩展，以及随项目修改的 SillyTavern 完整源码。酒馆的上游版本为 SillyTavern/SillyTavern 的 82b64a45c34facbc98ff4b9f33c067d3ccab6a17，许可证见 SillyTavern/LICENSE。

## 首次启动

1. 安装 Git、Node.js 22.15 或更新的 22.x（带 npm）。电脑和手机连同一局域网。
2. 拉取测试通过的代码并准备本机配置。

   ~~~powershell
   git clone -b test https://github.com/turquoisewater1123/Sundown-Tender.git
   cd Sundown-Tender
   Copy-Item .env.example .env
   ~~~

3. 在 .env 填写 MONGODB_URI、MONGODB_DB（默认 nightread）和自己的 KYRUNE_API_KEY。数据库须支持多文档事务。可在 [Atlas](https://cloud.mongodb.com/) 创建 Free 集群，在 Database Access 建立只对 nightread 有 readWrite 的用户，在 Network Access 放行服务器出口 IP，再复制 Drivers 提供的连接串。URI 密码中的特殊字符需按 URL 编码。每位独立部署者使用自己的数据库和模型凭据。
4. 在项目目录执行以下命令。脚本会安装锁定的 npm 依赖、准备酒馆示例卡并启动服务。多个网卡时可以追加 -InterfaceAlias WLAN，换成实际网卡名称。

   ~~~powershell
   powershell -ExecutionPolicy Bypass -File .\Run.ps1
   ~~~

5. 电脑打开 http://127.0.0.1:8002/novel/ 。酒馆在 http://127.0.0.1:8000/ 。手机访问终端打印的局域网地址，第一次启动自动生成登录信息，保存在 mobile-access.json；可在本机修改。Windows 防火墙需允许专用网络访问 TCP 8001。该入口使用局域网 HTTP，远程访问请配置 HTTPS。
6. [下载 Android 安装包](Novel/downloads/NightRead-Android.apk)，首次打开输入终端显示的 http://电脑局域网IP:8001。客户端依赖电脑端服务在线。

## 模型与文件

夜读默认使用 Kyrune Mini 聊天。Run.ps1 会把 Novel/settings.example.json 复制为忽略提交的 Novel/settings.json，可在此更换服务。SillyTavern 有独立的 API 连接面板，需要配置自己的模型。英文卡自动翻译目前还依赖本机 Ollama 服务 127.0.0.1:11435 的 qwen2.5:7b。图片、视频和语音服务按需配置。models/ 放模型配置；权重需单独获取。旧的 Start-Tavern、Keep-Tavern-Running 等脚本供已有便携运行时使用，新机器使用 Run.ps1。

夜读在云 MongoDB 保存聊天、分支、状态、翻译和媒体索引。用户角色卡、SillyTavern 自己的聊天文件、生成媒体、登录信息以及 Android 签名均存于服务器文件系统。迁移整台服务器时需另行私下复制这些文件；仅连接数据库不能恢复附件或酒馆的独立存档。

## 从已有 MongoDB 迁移

安装 MongoDB Database Tools。安排暂停写入并暂时停用守护进程，保持源 mongod 运行。目标须是空的 nightread 数据库，避免与已有聊天冲突。备份存到仓库以外的受限目录。从项目根目录运行：

~~~powershell
mongodump --uri="mongodb://127.0.0.1:27028/?replicaSet=nightread" --db=nightread --archive="$env:TEMP/nightread-migration.gz" --gzip
# 使用 .env 的 Atlas URI，在仅本机可访问的终端执行；不要把 URI 发送到 GitHub。
$targetUri = node --env-file=.env -p "process.env.MONGODB_URI"
mongorestore --uri="$targetUri" --nsInclude="nightread.*" --archive="$env:TEMP/nightread-migration.gz" --gzip --stopOnError
node --env-file=.env Novel/verify-migration.mjs
~~~

每一步都须成功再继续。核验脚本比较集合清单以及按 _id 排序的全部 BSON 数据摘要。通过后用 Run.ps1 启动云版本，确认历史、分支和新消息正常，再关闭旧 mongod。失败时保留源库和备份，修正问题后用新的空目标重试。

## Android 构建

安装 JDK 17，设置 JAVA_HOME；安装 Android SDK platform 35 和 build-tools 35.0.0，设置 ANDROID_HOME。Windows 执行 powershell -ExecutionPolicy Bypass -File Novel/android/Build-Android.ps1，产物为 Novel/downloads/NightRead-Android.apk。首次构建会生成本机签名，后续更新同一安装包须保留原签名。

## 分支与自动同步

日常修改推送 dev。GitHub Actions 安装依赖、初始化角色卡并执行语法与 APK 存在性检查；全部通过后自动将 test 快进到该提交，无需 PR 审核。test 用作发布分支，避免直接向 test 提交。仓库需启用 Actions 并允许工作流写入 contents。如果两条分支分叉，推送会失败并保留原历史。另一台电脑使用 git pull --ff-only 更新本地 test；升级后如锁文件变化，重新执行 npm ci --prefix Novel 与 npm ci --prefix SillyTavern，再重启服务。
