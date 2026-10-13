// Quick self-test: node test.js  (uses a temp data dir copy; does NOT touch your real data)
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ds26-'));
for(const f of ['server.js','problems.json','seed.json'])fs.copyFileSync(path.join(__dirname,f),path.join(tmp,f));
const PORT=3999,base='http://localhost:'+PORT;
const srv=cp.spawn('node',['server.js'],{cwd:tmp,env:{...process.env,PORT}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,failn=0;const ok=(c,m)=>{c?pass++:failn++;console.log((c?'PASS ':'FAIL ')+m)};
async function req(url,method='GET',data,cookie){
  const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:data?JSON.stringify(data):undefined});
  const sc=r.headers.get('set-cookie');let j={};try{j=await r.json()}catch{}
  return {s:r.status,j,cookie:sc?sc.split(';')[0]:null};
}
(async()=>{
  await sleep(2500);
  const seed=JSON.parse(fs.readFileSync(path.join(tmp,'seed.json')));
  // all 30 teams can log in (then log out)
  let all=true;for(const t of seed.teams){const r=await req('/api/login','POST',{username:t.name,password:t.password});if(r.s!==200)all=false;else await req('/api/logout','POST',{},r.cookie);}
  ok(all,'all 30 teams log in with their passwords');
  ok((await req('/api/login','POST',{username:'SkyStack',password:'wrong'})).s===401,'wrong password rejected');
  ok((await req('/api/login','POST',{username:'nobody',password:'x'})).s===401,'unknown team rejected');
  const a=await req('/api/login','POST',{username:'  skystack ',password:'bitsathyb'});ok(a.s===200,'login works case/space-insensitive');
  ok((await req('/api/login','POST',{username:'SkyStack',password:'bitsathyb'})).s===409,'second simultaneous login rejected');
  const b=await req('/api/login','POST',{username:'BITZAPP',password:'Pras@2006'});
  const adm=await req('/api/login','POST',{username:seed.admin.username,password:seed.admin.password});ok(adm.s===200,'admin login');
  ok((await req('/api/admin/window','POST',{open:true},a.cookie)).s===403,'team cannot use admin API');
  ok((await req('/api/claim','POST',{problemId:'PS12'},a.cookie)).s===403,'claim refused before window opens');
  ok((await req('/api/state','GET',null,a.cookie)).j.status==='NOT STARTED','initial status NOT STARTED');
  await req('/api/admin/window','POST',{open:true},adm.cookie);
  const rs=await Promise.all([req('/api/claim','POST',{problemId:'PS12'},a.cookie),req('/api/claim','POST',{problemId:'PS12'},b.cookie)]);
  ok(rs.filter(r=>r.s===200).length===1,'simultaneous claim of same problem -> exactly one winner');
  const winner=rs[0].s===200?a:b,loser=rs[0].s===200?b:a;
  ok((await req('/api/claim','POST',{problemId:'PS13'},winner.cookie)).s===409,'team cannot claim a second problem');
  ok((await req('/api/claim','POST',{problemId:'PS13'},loser.cookie)).s===200,'loser can pick another problem');
  const st=await req('/api/state','GET',null,adm.cookie);
  ok(st.j.counts.taken===2,'admin sees 2 taken');
  const rv=await req('/api/admin/revoke','POST',{problemId:'PS12',reason:'test'},adm.cookie);ok(rv.s===200,'admin revoke works');
  ok((await req('/api/state','GET',null,adm.cookie)).j.counts.taken===1,'problem free again after revoke');
  await req('/api/admin/window','POST',{open:false},adm.cookie);
  const c=await req('/api/login','POST',{username:'Eclipse',password:'Pishana@070807'});
  ok((await req('/api/claim','POST',{problemId:'PS01'},c.cookie)).s===403,'claim refused after window closed');
  const k=await req('/api/admin/kick','POST',{teamId:'T01'},adm.cookie);ok(k.s===200,'admin force logout');
  ok((await req('/api/state','GET',null,a.cookie)).s===401,'revoked session no longer works');
  const csv=await (await fetch(base+'/api/admin/export.csv',{headers:{Cookie:adm.cookie}})).text();
  ok(csv.split('\n').length===36,'CSV has header + 35 rows');
  console.log(`\n${pass} passed, ${failn} failed`);srv.kill();process.exit(failn?1:0);
})();
