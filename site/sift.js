/* Bounce classifier. Ruleset exported from github.com/singhrastu/smtpsift. */
(function(){
var D={"rules": [{"category": "blocklist", "provider": null, "pattern": "spamhaus|sbl\\.spamhaus|xbl\\.spamhaus|css\\.spamhaus|pbl\\.spamhaus", "note": "Spamhaus listing"}, {"category": "blocklist", "provider": null, "pattern": "spamcop|barracudacentral|sorbs|uceprotect|invaluement|\\bsurbl\\b|\\buribl\\b|dnsbl|\\brbl\\b|blocklist\\.de", "note": "Named DNSBL listing"}, {"category": "blocklist", "provider": "proofpoint", "pattern": "blocked using proofpoint|proofpoint.*block", "note": "Proofpoint filtering"}, {"category": "blocklist", "provider": "cloudmark", "pattern": "cloudmark|csi\\.cloudmark", "note": "Cloudmark reputation"}, {"category": "auth_failure", "provider": null, "pattern": "dmarc.*(fail|reject|polic)|failed dmarc|unauthenticated email|spf.*(fail|softfail|permerror)|dkim.*(fail|invalid|not signed)|5\\.7\\.26", "note": "SPF/DKIM/DMARC alignment or policy failure"}, {"category": "reputation_block", "provider": "microsoft", "pattern": "\\bs3140\\b|\\bs3150\\b|unfortunately, messages from|has been blocked by outlook\\.com|5\\.7\\.606|access denied, banned sending ip", "note": "Microsoft/Outlook IP reputation block"}, {"category": "reputation_block", "provider": "gmail", "pattern": "likely unsolicited mail|this message has been blocked because|suspicious due to the very low reputation|not accepted from ip", "note": "Gmail sender reputation block"}, {"category": "reputation_block", "provider": "yahoo", "pattern": "\\[ts0\\d+\\]|not accepted for policy reasons|mail server ip.*blocked", "note": "Yahoo policy/reputation block"}, {"category": "reputation_block", "provider": null, "pattern": "(poor|bad|low) reputation|sender reputation|reputation of the sending", "note": "Sender reputation block"}, {"category": "rate_limited", "provider": "gmail", "pattern": "4\\.7\\.28|unusual rate of unsolicited", "note": "Gmail rate limiting"}, {"category": "rate_limited", "provider": "microsoft", "pattern": "4\\.7\\.500|4\\.7\\.650|server busy|too many concurrent", "note": "Microsoft throttling"}, {"category": "rate_limited", "provider": null, "pattern": "too many (messages|connections|recipients)|rate limited|slow down|throttl|exceeded.*(limit|quota).*(hour|minute|day)|4\\.5\\.3", "note": "Rate limiting"}, {"category": "greylisted", "provider": null, "pattern": "grey ?list|gray ?list|try again later.*not previously|450 4\\.7\\.1.*try again", "note": "Greylisted"}, {"category": "content_block", "provider": null, "pattern": "spam content|message content|content filter|our content filters|high probability of spam|message (rejected|refused).*content|url.*(blacklist|blocked|reputation)|virus|malware|attachment.*not allowed", "note": "Content or URL reputation"}, {"category": "mailbox_full", "provider": null, "pattern": "mailbox (is )?full|over ?quota|quota exceeded|insufficient system storage|5\\.2\\.2|4\\.2\\.2", "note": "Recipient over quota"}, {"category": "mailbox_inactive", "provider": null, "pattern": "account (is )?(disabled|inactive|suspended|closed)|mailbox (disabled|inactive|not accepting)|no longer (in use|active|employed)|5\\.2\\.1", "note": "Mailbox disabled or dormant"}, {"category": "invalid_recipient", "provider": null, "pattern": "user unknown|unknown user|no such user|recipient (address )?rejected|does not exist|invalid (recipient|mailbox|address)|address (not found|unknown)|5\\.1\\.1|5\\.1\\.3|5\\.1\\.0|mailbox unavailable|no mailbox here", "note": "Recipient does not exist"}, {"category": "policy_block", "provider": null, "pattern": "policy (reasons|violation|restriction)|not authori[sz]ed to send|relay (access )?denied|recipient.*not accepting", "note": "Recipient-side policy"}, {"category": "connection", "provider": null, "pattern": "connection (timed out|refused|reset|closed)|could not connect|no route to host|\\btls\\b|\\bssl\\b|certificate|handshake|dns (error|failure)|host not found|lost connection|network is unreachable", "note": "Connection, TLS or DNS failure"}, {"category": "transient", "provider": null, "pattern": "temporar(y|ily)|try again|resources temporarily|internal error|service unavailable", "note": "Temporary remote condition"}], "actions": {"invalid_recipient": {"action": "suppress", "advice": "Permanent. Remove it. Retrying costs reputation."}, "mailbox_full": {"action": "retry", "advice": "Retry with backoff for a few days, then suppress."}, "mailbox_inactive": {"action": "suppress", "advice": "Dormant or disabled. Suppress - these turn into spam traps."}, "reputation_block": {"action": "pause", "advice": "Stop sending to this provider from this IP/domain and remediate."}, "content_block": {"action": "review", "advice": "Content or a linked domain triggered it. Fix the message, not the rate."}, "blocklist": {"action": "pause", "advice": "Delist first. Find the emitting source before you request removal."}, "rate_limited": {"action": "throttle", "advice": "Drop concurrency and rate for this provider, then retry."}, "greylisted": {"action": "retry", "advice": "Expected on first contact. Retry after the window."}, "auth_failure": {"action": "fix_config", "advice": "SPF/DKIM/DMARC problem. Retrying will not help."}, "policy_block": {"action": "review", "advice": "Recipient-side rule. Usually not your reputation."}, "connection": {"action": "retry", "advice": "Network/TLS/DNS. Retry, but investigate if it sticks to one route."}, "transient": {"action": "retry", "advice": "Temporary remote condition. Normal retry schedule."}, "unknown": {"action": "retry", "advice": "Unrecognised. Retry conservatively and add a rule."}}, "providers": {"gmail": "gmail|googlemail|gsmtp|google\\.com", "microsoft": "outlook|hotmail|office365|protection\\.outlook|microsoft|live\\.com", "yahoo": "yahoo|yahoodns|\\baol\\b", "proofpoint": "proofpoint|pphosted", "mimecast": "mimecast", "apple": "icloud|apple\\.com|\\bme\\.com\\b"}, "labels": {"invalid_recipient": "Invalid recipient", "mailbox_full": "Mailbox full", "mailbox_inactive": "Mailbox inactive", "reputation_block": "Reputation block", "content_block": "Content block", "blocklist": "Blocklist listing", "rate_limited": "Rate limited", "greylisted": "Greylisted", "auth_failure": "Authentication failure", "policy_block": "Recipient policy", "connection": "Connection failure", "transient": "Transient failure", "unknown": "Unrecognised"}, "pages": [{"code": "tls-handshake", "provider": null, "url": "/smtp/tls-handshake/", "title": "TLS handshake failures on outbound SMTP"}, {"code": "spamhaus", "provider": null, "url": "/smtp/spamhaus/", "title": "Blocked using Spamhaus: how to diagnose and get delisted"}, {"code": "5.7.606", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-5-7-606/", "title": "Microsoft 5.7.606: access denied, banned sending IP"}, {"code": "4.7.500", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-4-7-500/", "title": "Microsoft 4.7.500: server busy, throttled"}, {"code": "4.7.28", "provider": "Gmail", "url": "/smtp/gmail-4-7-28/", "title": "Gmail 4.7.28: unusual rate, deferred not blocked"}, {"code": "5.7.26", "provider": "Gmail", "url": "/smtp/gmail-5-7-26/", "title": "Gmail 5.7.26: unauthenticated mail rejected"}, {"code": "RP-001", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-rp-001/", "title": "Microsoft 421 RP-001: rate limited by Outlook.com"}, {"code": "RP-002", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-rp-002/", "title": "Microsoft 421 RP-002: too much mail on one connection"}, {"code": "RP-003", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-rp-003/", "title": "Microsoft 421 RP-003: too many simultaneous connections"}, {"code": "SC-001", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-sc-001/", "title": "Microsoft 550 SC-001: rejected for policy reasons"}, {"code": "SC-004", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-sc-004/", "title": "Microsoft 550 SC-004: blocked on complaints"}, {"code": "DY-001", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-dy-001/", "title": "Microsoft 550 DY-001: mail from dynamic address space"}, {"code": "5.7.1", "provider": "Gmail", "url": "/smtp/gmail-5-7-1/", "title": "Gmail 5.7.1: message blocked for reputation"}, {"code": "S3140", "provider": "Microsoft / Outlook", "url": "/smtp/microsoft-outlook-s3140/", "title": "Microsoft S3140: sending IP reputation block"}, {"code": "5.1.1", "provider": null, "url": "/smtp/5-1-1/", "title": "SMTP 5.1.1: recipient address does not exist"}, {"code": "4.2.2", "provider": null, "url": "/smtp/4-2-2/", "title": "SMTP 4.2.2: recipient mailbox is full"}, {"code": "5.2.1", "provider": null, "url": "/smtp/5-2-1/", "title": "SMTP 5.2.1: mailbox disabled or inactive"}, {"code": "5.7.1", "provider": null, "url": "/smtp/5-7-1/", "title": "SMTP 5.7.1: delivery not authorized, message refused"}, {"code": "4.4.1", "provider": null, "url": "/smtp/4-4-1/", "title": "SMTP 4.4.1: connection timed out or refused"}, {"code": "TS03", "provider": "Yahoo", "url": "/smtp/yahoo-ts03/", "title": "Yahoo TS03: deferred for policy reasons"}]};

var box=document.getElementById('sift-in'), out=document.getElementById('sift-out');
if(!box||!out) return;

var RX=D.rules.map(function(r){return {c:r.category,p:r.provider,n:r.note,
  rx:new RegExp(r.pattern,'i')};});
var PRX=Object.keys(D.providers).map(function(k){
  return {k:k,rx:new RegExp(D.providers[k],'i')};});

function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function classify(t){
  for(var i=0;i<RX.length;i++) if(RX[i].rx.test(t)) return RX[i];
  return {c:'unknown',p:null,n:'No rule matched this response.'};
}
function provider(t,hint){
  if(hint) return hint;
  for(var i=0;i<PRX.length;i++) if(PRX[i].rx.test(t)) return PRX[i].k;
  return null;
}
function refpage(t){
  for(var i=0;i<D.pages.length;i++){
    var p=D.pages[i];
    if(t.toLowerCase().indexOf(p.code.toLowerCase())>-1) return p;
  }
  return null;
}

/* A pasted mail log is many responses, not one string. Classifying the whole
   blob returned whichever rule matched first anywhere in it and called that the
   answer for all of it, which is wrong the moment somebody pastes more than one
   line. Continuation lines of a multiline reply ("250-first" through "250 last")
   still belong to one response. */
function splitResponses(text){
  var out=[], buf=[], lines=text.split(/\r?\n/), i, l;
  for(i=0;i<lines.length;i++){
    l=lines[i].trim();
    if(!l){ if(buf.length){out.push(buf.join(' '));buf=[];} continue; }
    buf.push(l);
    if(!/^\d{3}-/.test(l)){ out.push(buf.join(' ')); buf=[]; }
  }
  if(buf.length) out.push(buf.join(' '));
  return out;
}

function verdictHtml(t,lead){
  var hit=classify(t), prov=provider(t,hit.p),
      act=D.actions[hit.c]||D.actions.unknown, page=refpage(t);
  var h='<div class="head">'
      + '<span class="act a-'+esc(act.action)+'">'+esc(act.action.replace('_',' '))+'</span>'
      + '<span class="cat">'+esc(D.labels[hit.c]||hit.c)+'</span>'
      + (prov?'<span class="prov">'+esc(prov)+'</span>':'')
      + '</div>'
      + '<p class="why">'+esc(hit.n)+'. '+esc(act.advice)+'</p>';
  if(lead){
    if(page) h+='<p class="lnk"><a href="'+esc(page.url)+'">Read the '
             +esc((page.provider?page.provider+' ':'')+page.code)+' page &rarr;</a></p>';
    else h+='<p class="lnk"><a href="/smtp/">Browse the SMTP reference &rarr;</a></p>';
  }
  return h;
}

var t0=null;
function run(){
  var t=box.value.trim();
  if(!t){out.className='verdict';out.innerHTML='';return;}
  var items=splitResponses(t);
  if(items.length<2){
    out.innerHTML=verdictHtml(t,true);
    out.className='verdict on';
    return;
  }
  /* Group identical verdicts. An operator pasting a log wants "37 of these,
     12 of those", not thirty-seven cards. */
  var groups={}, order=[], i, hit, prov, key;
  for(i=0;i<items.length;i++){
    hit=classify(items[i]); prov=provider(items[i],hit.p);
    key=hit.c+'|'+(prov||'');
    if(!groups[key]){ groups[key]={n:0,sample:items[i]}; order.push(key); }
    groups[key].n++;
  }
  order.sort(function(a,b){return groups[b].n-groups[a].n;});
  var h='<p class="multi-head">'+items.length+' responses, '
      + order.length+(order.length===1?' verdict':' distinct verdicts')+'</p>';
  for(i=0;i<order.length;i++){
    var g=groups[order[i]];
    h+='<div class="grp"><span class="cnt">'+g.n+'</span>'
      + verdictHtml(g.sample,i===0)
      + '<p class="sample"><code>'+esc(g.sample.slice(0,150))+'</code></p></div>';
  }
  out.innerHTML=h;
  out.className='verdict on';
}
box.addEventListener('input',function(){clearTimeout(t0);t0=setTimeout(run,140);});
Array.prototype.forEach.call(document.querySelectorAll('[data-ex]'),function(b){
  b.addEventListener('click',function(){box.value=b.getAttribute('data-ex');run();box.focus();});
});
run();
})();
