"""Fixed observation code: page data is evidence, never agent instructions."""
CAPTURE = r"""({text_offset, max_chars, element_offset}) => {
  const clean=char=>char.length===1 && char.charCodeAt(0)>=0xD800 && char.charCodeAt(0)<=0xDFFF ? '\uFFFD' : char;
  const clip=(value,limit)=>{let out='',count=0; for(const char of String(value)){if(count++>=limit) break; out+=clean(char);} return out;};
  const all = Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"]'))
    .filter(el => {const rect=el.getBoundingClientRect(), style=getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';});
  let nodes = all.slice(element_offset, element_offset + 80);
  let controls = nodes.map(el => {
    const tag=el.tagName.toLowerCase(), type=(el.getAttribute('type') || '').toLowerCase();
    const secret=type==='password' || (el.getAttribute('autocomplete') || '').includes('password');
    const label=el.getAttribute('aria-label') || Array.from(el.labels || []).map(x=>x.innerText).join(' ') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || '';
    return {tag, type, role:el.getAttribute('role') || tag, name:clip(label,500),
      disabled:el.matches(':disabled') || el.getAttribute('aria-disabled')==='true',
      value:secret ? null : 'value' in el ? clip(el.value,1000) : null,
      redacted:secret, checked:'checked' in el ? !!el.checked : null,
      href:tag==='a' ? clip(el.href,3000) : null,
      options:tag==='select' ? Array.from(el.options).slice(0,20).map(x=>({value:clip(x.value,100),text:clip(x.text,100)})) : null,
      options_truncated:tag==='select' && el.options.length>20};
  });
  let size=0,count=0;
  for (const control of controls) {const bytes=new TextEncoder().encode(JSON.stringify(control)).length; if(size+bytes>28000) break; size+=bytes; count++;}
  nodes=nodes.slice(0,count); controls=controls.slice(0,count);
  const text=document.body ? document.body.innerText : '';
  let excerpt='',length=0;
  for(const char of text){if(length>=text_offset && length<text_offset+max_chars) excerpt+=clean(char); length++;}
  return {data:{url:clip(location.href,3000),title:clip(document.title,500),text:excerpt,
    text_length:length,controls,element_count:all.length},nodes};
}"""
