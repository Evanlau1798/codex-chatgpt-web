export function effortReadinessHtml(language = "fr", scenario = "delayed-close", initialValue = 4): string {
  return `<form><div id="prompt-textarea" contenteditable="true">Draft to preserve</div>
    <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Pro</button></form>
    <div id="picker" role="menu" hidden>
    <div role="menuitemradio" aria-checked="true">${language === "fr" ? "Le plus récent" : "Latest"}</div>
    <div role="menuitem" tabindex="0" aria-describedby="status"><div data-model-picker-power-slider style="height:30px;width:250px"></div></div>
    <span id="status"></span></div>
    <script>
      const language=${JSON.stringify(language)}, scenario=${JSON.stringify(scenario)};
      const labels=language==='fr'?['Instantané','Moyen','Élevée','Très élevé','Pro']:['Instant','Medium','High','Extra High','Pro'];
      let value=${initialValue}, closes=0, pending=false;
      const control=document.querySelector('button'), menu=document.querySelector('#picker'), composer=document.querySelector('#prompt-textarea');
      function render() {
        document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'
          +Array.from({length:5},(_,i)=>'<span data-selected="'+(i<=value)+'" data-locked="false"></span>').join('')
          +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="'+value+'"></span></span>';
        document.querySelector('#status').textContent=labels[value]+', '+(value+1)+(language==='fr'?' sur ':' of ')+'5.';
      }
      control.onclick=()=>{menu.hidden=false;control.setAttribute('aria-expanded','true');control.textContent=language==='fr'?'Effort de réflexion':'Thinking effort';render()};
      document.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&!menu.hidden&&!pending){
          closes++; pending=true;
          if(scenario==='persistent-open') return;
          if(scenario==='navigate') location.hash='changed';
          composer.contentEditable='false';
          const delay=scenario==='delayed-close'||scenario==='family-readback'&&closes===3?650:0;
          setTimeout(()=>{
            if(scenario==='wrong-effort'&&closes===1)value=1;
            if(scenario==='wrong-family'&&closes===1)document.querySelector('[role="menuitemradio"]').setAttribute('aria-checked','false');
            if(scenario==='ambiguous'&&closes===1)control.parentNode.append(control.cloneNode(true));
            menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=labels[value];pending=false;
            setTimeout(()=>{composer.contentEditable='true'},scenario==='delayed-editor'?650:0);
            render();
          },delay);
        } else if(event.key==='ArrowRight'||event.key==='ArrowLeft'){
          value=Math.max(0,Math.min(4,value+(event.key==='ArrowRight'?1:-1)));render();event.preventDefault();
        }
      });render();control.textContent=labels[value];
    </script>`;
}
