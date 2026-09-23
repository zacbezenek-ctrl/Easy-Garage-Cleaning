(() => {
'use strict';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.hash.slice(1));let invitation=params.get('invite')||'';
history.replaceState(null,'',location.pathname);
async function call(payload){const response=await fetch('/api/staff-setup',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-EGC-Staff-Setup':'1'},body:JSON.stringify(payload)});const body=await response.json();if(!response.ok)throw new Error(body.error||'Setup could not be completed.');return body;}
async function init(){try{if(!invitation)throw new Error('Open the private setup link in the email Zac sent you.');const account=await call({action:'inspect',invite:invitation});$('identity').textContent=account.name+' · Username: '+account.username;$('email').value=account.email;$('status').textContent='This invitation expires '+new Date(account.expiresAt).toLocaleString()+'.';$('setup').hidden=false;}catch(error){$('status').textContent=error.message;}}
$('setup').addEventListener('submit',async event=>{event.preventDefault();const password=$('password').value,confirmPassword=$('confirm').value;if(password!==confirmPassword){$('status').textContent='The two passwords do not match.';return;}$('activate').disabled=true;try{const result=await call({action:'redeem',invite:invitation,email:$('email').value,password,confirmPassword});invitation='';$('setup').reset();$('setup').hidden=true;$('complete').hidden=false;$('status').textContent='Account activated. Your username is '+result.username+'.';}catch(error){$('status').textContent=error.message;$('password').value='';$('confirm').value='';}finally{$('activate').disabled=false;}});
init();
})();
