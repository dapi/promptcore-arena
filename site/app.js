const size = 12;
const walls = new Set(['2,2','2,3','2,8','3,8','4,4','4,5','5,4','6,7','7,7','8,2','8,3','9,8']);
const energy = new Set(['1,5','3,3','4,9','6,2','7,5','9,6','10,9']);
const turns = [
  {units:{A:[1,1,100],B:[1,10,100],C:[10,1,100],D:[10,10,100]},highlight:'1,5',event:'Агент A разведывает путь к источнику энергии.',quote:'«Сначала соберу энергию, затем займу центр»',type:'СТРАТЕГИЯ'},
  {units:{A:[1,3,100],B:[3,9,100],C:[9,2,100],D:[9,9,100]},highlight:'1,3',event:'Агент A обходит препятствие и сохраняет дистанцию.',quote:'«Пока соперники далеко, риск не оправдан»',type:'РАЗВЕДКА'},
  {units:{A:[1,5,100],B:[4,9,100],C:[7,3,100],D:[8,8,100]},highlight:'1,5',event:'Агент A собирает энергию для следующего манёвра.',quote:'«Запас энергии даст выбор на следующем ходу»',type:'РЕСУРСЫ'},
  {units:{A:[3,5,100],B:[5,9,100],C:[6,3,100],D:[7,8,100]},highlight:'5,8',event:'Агент D ставит ловушку у прохода к центру.',quote:'«Лучше контролировать путь, чем гнаться за врагом»',type:'ЛОВУШКА',trap:'5,8'},
  {units:{A:[4,6,100],B:[5,9,75],C:[5,3,100],D:[7,8,100]},highlight:'5,9',event:'Агент A атакует B, пока тот занят обходом ловушки.',quote:'«Короткая атака сейчас безопаснее преследования»',type:'АТАКА',trap:'5,8'},
  {units:{A:[5,6,80],B:[5,9,55],C:[5,3,100],D:[7,8,100]},highlight:'5,6',event:'Агент A удерживает центр. Матч продолжается.',quote:'«Сохраняю позицию и готовлю защиту»',type:'КОНТРОЛЬ',trap:'5,8'}
];

const board = document.querySelector('#board');
const agentList = document.querySelector('#agent-list');
const range = document.querySelector('#turn-range');
const previous = document.querySelector('#prev-turn');
const next = document.querySelector('#next-turn');
const play = document.querySelector('#play-turn');
const colors = {A:'var(--green)',B:'var(--pink)',C:'var(--blue)',D:'var(--orange)'};
let current = 0;
let timer;

function render(index){
  current = index;
  const turn = turns[index];
  board.replaceChildren();
  for(let row=0;row<size;row++){
    for(let col=0;col<size;col++){
      const key=`${row},${col}`;
      const cell=document.createElement('div');
      cell.className=`cell${walls.has(key)?' wall':''}${energy.has(key)?' energy':''}${turn.trap===key?' trap':''}${turn.highlight===key?' active':''}`;
      const unit=Object.entries(turn.units).find(([,state])=>state[0]===row&&state[1]===col);
      if(unit){
        const pawn=document.createElement('span');
        pawn.className=`unit ${unit[0].toLowerCase()}`;
        pawn.textContent=unit[0];
        cell.append(pawn);
      }
      board.append(cell);
    }
  }
  const positions=Object.entries(turn.units).map(([name,state])=>`${name}: строка ${state[0]+1}, столбец ${state[1]+1}, здоровье ${state[2]}%`);
  board.setAttribute('aria-label',`Карта демонстрационного боя, ход ${index+1}. ${positions.join('. ')}.`);
  agentList.replaceChildren();
  for(const [name,state] of Object.entries(turn.units)){
    const item=document.createElement('div');
    item.className='agent';
    item.style.setProperty('--agent-color',colors[name]);
    const code=document.createElement('span');code.className='agent-code';code.textContent=name;
    const label=document.createElement('span');label.textContent=`АГЕНТ ${name}`;
    const health=document.createElement('span');health.className='health';health.textContent=`${state[2]}%`;
    item.append(code,label,health);agentList.append(item);
  }
  document.querySelector('#turn-label').textContent=`ХОД ${String(index+1).padStart(2,'0')} / 06`;
  document.querySelector('#event-kicker').textContent=`ХОД ${String(index+1).padStart(2,'0')} · ${turn.type}`;
  document.querySelector('#event-text').textContent=turn.event;
  document.querySelector('#event-quote').textContent=turn.quote;
  range.value=String(index);
  previous.disabled=index===0;
  next.disabled=index===turns.length-1;
}

function stop(){clearInterval(timer);timer=undefined;play.innerHTML='▶ <span>Играть</span>';play.setAttribute('aria-label','Воспроизвести');}
function start(){
  if(current===turns.length-1)render(0);
  play.innerHTML='Ⅱ <span>Пауза</span>';play.setAttribute('aria-label','Приостановить');
  timer=setInterval(()=>{if(current===turns.length-1){stop();return;}render(current+1);},1250);
}
previous.addEventListener('click',()=>{stop();render(Math.max(0,current-1));});
next.addEventListener('click',()=>{stop();render(Math.min(turns.length-1,current+1));});
play.addEventListener('click',()=>timer?stop():start());
range.addEventListener('input',()=>{stop();render(Number(range.value));});
render(0);
