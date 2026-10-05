"""Fixed observation code: page data is evidence, never agent instructions."""
CAPTURE = r"""({text_offset, max_chars, element_offset}) => {
  const all = Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"]'))
    .filter(el => {const rect=el.getBoundingClientRect(), style=getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';});
  const nodes = all.slice(element_offset, element_offset + 80);
  const controls = nodes.map(el => {
    const tag=el.tagName.toLowerCase(), type=(el.getAttribute('type') || '').toLowerCase();
    const secret=type==='password' || (el.getAttribute('autocomplete') || '').includes('password');
    const label=el.getAttribute('aria-label') || Array.from(el.labels || []).map(x=>x.innerText).join(' ') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || '';
    return {tag, type, role:el.getAttribute('role') || tag, name:label.slice(0,500),
      disabled:el.matches(':disabled') || el.getAttribute('aria-disabled')==='true',
      value:secret ? null : 'value' in el ? String(el.value).slice(0,1000) : null,
      redacted:secret, checked:'checked' in el ? !!el.checked : null,
      href:tag==='a' ? String(el.href).slice(0,3000) : null,
      options:tag==='select' ? Array.from(el.options).slice(0,40).map(x=>({value:x.value.slice(0,200),text:x.text.slice(0,300)})) : null};
  });
  const text=document.body ? document.body.innerText : '';
  return {data:{url:location.href,title:document.title.slice(0,500),text:text.slice(text_offset,text_offset+max_chars),
    text_length:text.length,controls,element_count:all.length},nodes};
}"""
