import { spawn } from 'node:child_process';
const windows=process.platform==='win32';
const children=['dev:api','dev:web'].map((task) => spawn(windows?'npm.cmd':'npm',['run',task],{stdio:'inherit',shell:windows,windowsHide:true}));
let stopping=false;
function stop(code=0) {
  if(stopping)return;stopping=true;
  for(const child of children) child.kill('SIGTERM');
  process.exitCode=code;
}
for(const child of children) child.on('exit',(code) => { if(!stopping)stop(code??1); });
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());

