'use strict';
/**
 * 把所有 .bat 的换行统一成 CRLF（按字节处理，不碰编码）。
 *
 * 背景：cmd.exe 解析「含 UTF-8 中文的纯 LF 批处理」时会错位吃掉字符
 * （例：title -> 'itle'，goto -> 'oto'），中文启动脚本会整个失效。
 * 已由 4 组对照实验证实：ASCII+LF 正常，中文+LF 坏，中文+CRLF 正常。
 *
 * 用法：node .tmp/fix-crlf.js <file...>
 */
const fs = require('fs');

let fixed = 0, ok = 0;
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  const before = { cr: 0, lf: 0 };
  for (const b of buf) { if (b === 13) before.cr++; else if (b === 10) before.lf++; }

  // 先统一成 LF，再全部换成 CRLF（幂等，不产生 \r\r\n）
  const lfOnly = buf.toString('latin1').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out = Buffer.from(lfOnly.replace(/\n/g, '\r\n'), 'latin1');

  const after = { cr: 0, lf: 0 };
  for (const b of out) { if (b === 13) after.cr++; else if (b === 10) after.lf++; }

  if (before.cr !== after.cr) {
    fs.writeFileSync(f, out);
    fixed++;
    console.log('  [已修] ' + f + '   CR ' + before.cr + ' -> ' + after.cr + ' (LF=' + after.lf + ')');
  } else {
    ok++;
    console.log('  [已OK] ' + f + '   CR=' + after.cr + ' LF=' + after.lf);
  }
}
console.log('\n共 ' + fixed + ' 个已修正，' + ok + ' 个本来就正常。');
