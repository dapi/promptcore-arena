export const AVATARS = [
  {id:'sentinel',name:'Страж'}, {id:'spectre',name:'Спектр'},
  {id:'drone',name:'Дрон'}, {id:'scarab',name:'Скарабей'},
  {id:'prism',name:'Призма'}, {id:'knight',name:'Рыцарь'},
];
export const DEFAULT_FIGHTERS = [
  {id:'A',name:'Вектор',avatar:'sentinel',color:'#66d9f2'},
  {id:'B',name:'Фантом',avatar:'spectre',color:'#be9dff'},
];
export function normalizeFighters(value) {
  return DEFAULT_FIGHTERS.map((base,i)=>{
    const f=value?.[i] || {};
    return {...base,name:typeof f.name==='string'&&f.name.trim()?f.name.trim().slice(0,24):base.name,avatar:AVATARS.some(v=>v.id===f.avatar)?f.avatar:base.avatar,color:/^#[0-9a-f]{6}$/i.test(f.color)?f.color:base.color};
  });
}
export function fighterName(match,id) {return normalizeFighters(match?.fighters).find(f=>f.id===id)?.name || id;}
export function avatarSvg(avatar,color) {
  const ink=/^#[0-9a-f]{6}$/i.test(color)?color:'#66d9f2';
  const shapes={
    sentinel:'<path d="M13 8h29l10 11v32L42 57H13L7 47V19z"/><path d="M15 16h25l6 7H15z" fill="currentColor"/><path d="M13 27h36v15H13z" fill="#070f18"/><path d="M19 32h8v4h-8zm18 0h8v4h-8zM19 48h23v3H19z" fill="currentColor" stroke="none"/>',
    spectre:'<path d="m8 5 15 11h18L56 5l-5 37-19 17L13 42z"/><path d="m17 23 15 7 15-7-5 21-10 8-10-8z" fill="#070e18"/><path d="m17 25 12 5-2 5-8-3zm30 0-12 5 2 5 8-3z" fill="currentColor" stroke="none"/><path d="M32 36v11"/>',
    drone:'<circle cx="32" cy="32" r="19"/><path d="M14 15 8 5 3 17l12 5zm36 0L56 5l5 12-12 5zM27 49l5 12 5-12"/><circle cx="32" cy="32" r="12" fill="#07111a"/><circle cx="32" cy="32" r="6" fill="currentColor"/><path d="M18 47 9 53m37-6 9 6"/>',
    scarab:'<path d="M17 22 7 15 3 24m14 7L3 34m14 8L7 52l-4-7m44-23 10-7 4 9m-14 7 14 3m-14 8 10 10 4-7" fill="none" stroke-width="3"/><path d="M22 9h20l7 17-5 21-12 12-12-12-5-21z"/><path d="m22 15 10 8 10-8M32 24v28"/><path d="M23 28h6v5h-6zm12 0h6v5h-6z" fill="currentColor" stroke="none"/>',
    prism:'<path d="m32 3 27 29-27 29L5 32z"/><path d="m32 13 17 19-17 19-17-19z" fill="#08121c"/><path d="m32 22 9 10-9 10-9-10z" fill="currentColor"/><path d="M32 3v10m27 19H49M32 61V51M5 32h10"/>',
    knight:'<path d="m30 3 11 8-6 13-10-2z" fill="currentColor"/><path d="m15 21 17-9 17 9 6 17-12 17H21L9 38z"/><path d="m15 31 17-5 17 5-5 8H20z" fill="#08121c"/><path d="M21 32h8m6 0h8M24 44v6m8-8v10m8-8v6"/>',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="#16212d" stroke="${ink}" color="${ink}" stroke-width="2" stroke-linejoin="round">${shapes[avatar]||shapes.sentinel}</g></svg>`;
}
export const avatarUrl = fighter => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(fighter.avatar,fighter.color))}`;
