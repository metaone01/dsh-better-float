import {captureControls} from '../src/detach/semantic-adapter.ts'
export function run(){
  let checks=0
  const equal=(actual,expected,label)=>{checks++;if(actual!==expected)throw Error(`${label}: expected ${expected}, got ${actual}`)}
  const root=document.createElement('section'),button=document.createElement('button'),input=document.createElement('input')
  button.type='button';button.textContent='Count 0';input.value='draft';root.append(button,input);document.body.append(root)
  let clicks=0,inputs=0
  button.addEventListener('click',()=>{button.textContent=`Count ${++clicks}`})
  input.addEventListener('input',()=>inputs++)
  try{
    const adapter=captureControls(root)
    equal(adapter.read(0).controls[0].text,'Count 0','initial button snapshot')
    adapter.apply({seq:1,key:'c0',kind:'click'})
    equal(clicks,1,'one action invokes native handler once')
    equal(adapter.read(1).controls[0].text,'Count 1','updated state can be snapshotted')
    adapter.apply({seq:2,key:'c1',kind:'input',value:'edited'})
    equal(input.value,'edited','native input setter receives command')
    equal(inputs,1,'input event dispatches once')
    input.readOnly=true
    let failed=false;try{adapter.apply({seq:3,key:'c1',kind:'input',value:'bad'})}catch{failed=true}
    equal(failed,true,'readOnly is enforced at source')
    input.readOnly=false;input.type='password'
    failed=false;try{adapter.read(2)}catch{failed=true}
    equal(failed,true,'dynamic sensitive type stops adapter')
    input.type='text'
    input.replaceWith(input.cloneNode())
    failed=false;try{adapter.read(3)}catch{failed=true}
    equal(failed,true,'replaced source stops rather than targeting another control')
    equal(root.isConnected,true,'original source never hidden or removed')
    const unsupported=document.createElement('input');unsupported.type='password';root.append(unsupported)
    failed=false;try{captureControls(unsupported)}catch{failed=true}
    equal(failed,true,'password excluded before export')
    return{checks}
  }finally{root.remove()}
}
