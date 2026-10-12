import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const vaultPath = process.env.VAULT_PATH || process.argv[2]

if (!vaultPath) {
  console.error('请指定目标 Obsidian 库目录路径，例如：')
  console.error('  VAULT_PATH="/path/to/your/vault" npm run install-vault')
  console.error('  或：node scripts/install-to-vault.mjs "/path/to/your/vault"')
  process.exit(1)
}

if (!fs.existsSync(vaultPath)) {
  console.error(`未找到目标 Obsidian 库目录：${vaultPath}`)
  process.exit(1)
}

const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'pdf-collation')
fs.mkdirSync(pluginDir, { recursive: true })

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const src = path.resolve(file)
  const dest = path.join(pluginDir, file)
  fs.copyFileSync(src, dest)
}

console.log(`已安装插件到：${pluginDir}`)
console.log('打开 Obsidian -> 设置 -> 第三方插件 -> 刷新并启用 "PDF Collation (双轨校勘)" 即可体验。')
