// ==UserScript==
// @name         Snail in Cherry
// @namespace    snail-in-cherry
// @author       0_"
// @version      1.5.0
// @description  독립 상점 구매·알 심기·부화·펫 판매·펫 먹이·스킨과 설정 백업
// @match        https://1227719606223765687.discordsays.com/*
// @match        https://magiccircle.gg/r/*
// @match        https://magicgarden.gg/r/*
// @match        https://starweaver.org/r/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      mg-api.ariedam.fr
// @connect      discord.com
// @connect      raw.githubusercontent.com
// @connect      *
// @updateURL    https://raw.githubusercontent.com/migm-user/cg/main/Snail%20in%20Cherry.user.js
// @downloadURL  https://raw.githubusercontent.com/migm-user/cg/main/Snail%20in%20Cherry.user.js
// ==/UserScript==

/* Protocol and geometry checked against the supplied Arie's Mod 3.2.217 and
 * MG-AFK-Portable sources. No other mod, local server or injected atom store is
 * required. This file observes the game's existing connection; it never logs in
 * or creates a second game connection. Native team reads use the game's own
 * state store, never another mod's saved teams. CommonJS exports are for tests. */
(function () {
  'use strict';
  const VERSION = '1.5.0', KEY = 'snail-in-cherry.settings.v1';
  const API = 'https://mg-api.ariedam.fr';
  const FIELDS = { Seed: 'species', Egg: 'eggId', Tool: 'toolId', Decor: 'decorId' };
  const COLS = 20, ROWS = 10, CAPACITY = 98;
  const clone = value => JSON.parse(JSON.stringify(value));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const quantity = item => finite(item?.quantity) ? Math.max(0, item.quantity) : 1;
  const itemId = item => String(item?.[FIELDS[item?.itemType]] || '');
  const choiceKey = item => `${item.itemType}:${itemId(item)}`;
  // Public /data verified 2026-09-27 (v1294); used only when catalog fields are absent.
  const TOOL_LIMIT_FALLBACK = {
    WateringCan:99,CropCleanser:99,ChilledPotion:99,FrozenPotion:99,
    ReplenishPotion:99,XPPotion:99,RainbowPotion:99,
    WetPotion:1,DawnlitPotion:1,AmberlitPotion:1,GoldPotion:1,Shovel:1,Camera:1
  };
  function purchaseCapacity(data,item,metadata = {}) {
    const id=itemId(item), info={...metadata,...item};
    const held=(data.inventory?.items || []).reduce((sum,entry) =>
      sum+(entry?.itemType === item.itemType && itemId(entry) === id ? quantity(entry) : 0),0);
    const max=Number(info.maxInventoryQuantity);
    const limit=info.isOneTimePurchase === true ? 1 : Number.isFinite(max) && max>0 ? Math.floor(max) :
      !own(info,'maxInventoryQuantity') && !own(info,'isOneTimePurchase') && item.itemType === 'Tool' ? TOOL_LIMIT_FALLBACK[id] ?? Infinity : Infinity;
    return {held,limit,remaining:Math.max(0,limit-held)};
  }
  const STORAGE_FOR = { Seed:'SeedSilo',Tool:'ToolShack',Decor:'DecorShed' };
  // v1422 MoveItem uses catalog keys for stacks; lock commands still use individual IDs.
  const moveItemKey = item => FIELDS[item?.itemType] ? itemId(item) : String(item?.id || '');
  const storageItems = storage => Array.isArray(storage?.items) ? storage.items : [];
  const storageCount = (storage,item) => storageItems(storage).reduce((sum,entry) =>
    sum+(entry && (!entry.itemType || entry.itemType===item.itemType) && entry[FIELDS[item.itemType]]===itemId(item) ? quantity(entry) : 0),0);
  function storagePlan(data,item,purchased,heldBefore,storageMeta = {}) {
    const storageId=STORAGE_FOR[item.itemType];
    if(!storageId)return {reason:''};
    const storage=data.inventory?.storages?.find(s=>(s?.decorId || s?.id)===storageId);
    if(!storage)return {reason:'보관함 없음 · 인벤토리 유지'};
    const entries=(data.inventory.items || []).filter(i=>i?.itemType===item.itemType && itemId(i)===itemId(item));
    const held=entries.reduce((n,i)=>n+quantity(i),0),amount=Math.min(purchased,Math.max(0,held-heldBefore));
    if(amount<=0)return {reason:'구매 수량 확인 대기 · 인벤토리 유지'};
    let slots=storage.capacitySlots;
    if(!finite(slots)) {
      const level=Number(storage.capacityLevel)||0;
      slots=level>0 ? storageMeta.upgrades?.[level-1]?.toCapacitySlots : storageMeta.baseCapacitySlots;
    }
    if(!finite(slots))return {reason:'보관함 용량 확인 대기 · 인벤토리 유지'};
    const stackable=item.itemType!=='Tool' || entries.some(i=>finite(i.quantity));
    const merges=stackable && storageCount(storage,item)>0;
    if(!merges && storageItems(storage).filter(Boolean).length>=slots)return {reason:'보관함 가득 참 · 인벤토리 유지'};
    const entry=entries.find(i=>!i.locked && !(data.inventory.favoritedItemIds || []).includes(i.id || itemId(i)));
    if(!entry)return {reason:'잠긴 품목 · 인벤토리 유지'};
    return {storage,storageId,held,amount:Math.min(amount,quantity(entry)),itemKey:moveItemKey(entry)};
  }
  const defaults = () => ({
    autoBuy: false, autoStore: false, autoFeed: false, buy: {},
    feed: { hungerPotion:true,allowed:{},openEggs:[],openPets:[],webhook:{enabled:false,url:''} },
    eggs: { order: [], enabled: {}, direction: '좌' },
    protect: { gold: false, rainbow: false, str: false, threshold: 95 },
    teams: { hatch: '', sell: '', restore: 'current' },
    registeredTeams: [], manualTeamsOpen: false,
    webhook: { enabled: false, url: '' }, position: null, panelPosition: null, collapsedShops: []
  });
  function settingsFrom(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('설정 객체가 아닙니다.');
    const s = defaults();
    const bool = (src, key, dst) => {
      if (own(src, key)) {
        if (typeof src[key] !== 'boolean') throw Error(`${key}: On/Off 값이 잘못되었습니다.`);
        dst[key] = src[key];
      }
    };
    for (const key of ['autoBuy', 'autoStore', 'autoFeed','manualTeamsOpen']) bool(raw, key, s);
    for (const section of ['eggs', 'protect', 'teams', 'webhook', 'feed']) {
      if (own(raw, section) && (!raw[section] || typeof raw[section] !== 'object' || Array.isArray(raw[section]))) throw Error(`${section}: 형식 오류`);
    }
    const dict = source => {
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length > 5000) throw Error('선택 목록 형식 오류');
      const result = {};
      for (const [key, value] of Object.entries(source)) {
        if (!/^[\w:.-]{1,160}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'boolean') throw Error('선택 목록 값 오류');
        result[key] = value;
      }
      return result;
    };
    if (own(raw, 'buy')) s.buy = dict(raw.buy);
    if(raw.feed) {
      bool(raw.feed,'hungerPotion',s.feed);
      if(own(raw.feed,'allowed'))s.feed.allowed=dict(raw.feed.allowed);
      for(const key of ['openEggs','openPets'])if(own(raw.feed,key)) {
        if(!Array.isArray(raw.feed[key]) || raw.feed[key].length>1000 || raw.feed[key].some(v=>typeof v!=='string'||!/^[\w:.-]{1,160}$/.test(v)))throw Error('펫 먹이 접기 설정 오류');
        s.feed[key]=[...new Set(raw.feed[key])];
      }
      if(own(raw.feed,'webhook')) {
        const hook=raw.feed.webhook;
        if(!hook || typeof hook!=='object' || Array.isArray(hook))throw Error('펫 먹이 웹후크 설정 오류');
        bool(hook,'enabled',s.feed.webhook);
        if(own(hook,'url')) {
          if(typeof hook.url!=='string'||hook.url.length>2048)throw Error('펫 먹이 웹후크 주소 오류');
          s.feed.webhook.url=hook.url.trim();if(s.feed.webhook.url)webhookURL(s.feed.webhook.url);
        }
      }
    }
    if (raw.eggs) {
      if (own(raw.eggs, 'order')) {
        if (!Array.isArray(raw.eggs.order) || raw.eggs.order.length > 1000 || raw.eggs.order.some(id => typeof id !== 'string' || !/^[\w.-]{1,120}$/.test(id) || ['__proto__','constructor','prototype'].includes(id))) throw Error('알 순서 형식 오류');
        s.eggs.order = [...new Set(raw.eggs.order)];
      }
      if (own(raw.eggs, 'enabled')) s.eggs.enabled = dict(raw.eggs.enabled);
      if (own(raw.eggs, 'direction')) {
        if (!['상','하','좌','우'].includes(raw.eggs.direction)) throw Error('심기 방향 오류');
        s.eggs.direction = ['좌','우'].includes(raw.eggs.direction) ? raw.eggs.direction : '좌';
      }
    }
    if (raw.protect) {
      for (const key of ['gold','rainbow','str']) bool(raw.protect, key, s.protect);
      if (own(raw.protect, 'threshold')) {
        if (!Number.isInteger(raw.protect.threshold) || raw.protect.threshold < 0 || raw.protect.threshold > 1000000) throw Error('STR은 0 이상 1,000,000 이하 정수로 입력하세요.');
        s.protect.threshold = raw.protect.threshold;
      }
    }
    for (const key of ['hatch','sell','restore']) if (own(raw.teams, key)) {
      if (typeof raw.teams[key] !== 'string' || raw.teams[key].length > 160) throw Error('팀 설정 형식 오류');
      s.teams[key] = raw.teams[key];
    }
    if(own(raw,'registeredTeams')) {
      const validId=v=>typeof v==='string' && /^[\w:.-]{1,160}$/.test(v);
      if(!Array.isArray(raw.registeredTeams) || raw.registeredTeams.length>60)throw Error('직접 등록한 프리셋 형식 오류');
      const seen=new Set();
      for(const t of raw.registeredTeams) {
        if(!t || !validId(t.id) || !validId(t.accountId) || typeof t.name!=='string' || !t.name.trim() || t.name.length>80 ||
          !Array.isArray(t.members) || t.members.length<1 || t.members.length>3 || t.members.some(m=>!validId(m?.petId)) || new Set(t.members.map(m=>m.petId)).size!==t.members.length)throw Error('직접 등록한 프리셋 값 오류');
        const key=t.accountId+':'+t.id;if(seen.has(key))throw Error('중복된 직접 등록 프리셋');seen.add(key);
        s.registeredTeams.push({id:t.id,accountId:t.accountId,name:t.name.trim(),members:t.members.map(m=>({petId:m.petId}))});
      }
    }
    if (raw.webhook) {
      bool(raw.webhook, 'enabled', s.webhook);
      if (own(raw.webhook, 'url')) {
        if (typeof raw.webhook.url !== 'string' || raw.webhook.url.length > 2048) throw Error('웹후크 주소 형식 오류');
        s.webhook.url = raw.webhook.url.trim();
        if (s.webhook.url) webhookURL(s.webhook.url);
      }
    }
    for (const key of ['position','panelPosition']) if (raw[key] != null) {
      if (!finite(raw[key].left) || !finite(raw[key].top)) throw Error('창 또는 아이콘 위치 형식 오류');
      s[key] = { left: raw[key].left, top: raw[key].top };
    }
    if (own(raw,'collapsedShops')) {
      if (!Array.isArray(raw.collapsedShops) || raw.collapsedShops.some(type=>!own(FIELDS,type))) throw Error('상점 접기 설정 오류');
      s.collapsedShops = [...new Set(raw.collapsedShops)];
    }
    return s;
  }
  function parseSettings(text) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw Error('설정 파일은 1MB 이하여야 합니다.');
    const pack = JSON.parse(text);
    if (pack?.format !== 'Snail in Cherry' || pack.version !== 1) throw Error('지원하는 Snail in Cherry 설정 파일이 아닙니다.');
    return settingsFrom(pack.settings);
  }
  function webhookURL(text) {
    const u = new URL(text);
    if (u.protocol !== 'https:' || u.hostname !== 'discord.com' || u.port || u.username || u.password || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(u.pathname)) throw Error('Discord 웹후크 주소를 확인하세요.');
    u.search = '?wait=true'; u.hash = ''; return u.href;
  }
  function orderedTiles(direction, tiles = Array.from({ length: COLS * ROWS }, (_, i) => i)) {
    const groups = new Map();
    for (const tile of tiles) {
      if (!Number.isInteger(tile) || tile < 0 || tile >= COLS * ROWS) continue;
      const major = tile % COLS;
      if (!groups.has(major)) groups.set(major, []);
      groups.get(major).push(tile);
    }
    const reverse = direction === '우';
    const majors = [...groups.keys()].sort((a,b) => reverse ? b-a : a-b);
    // Alternation uses the physical row/column, even when an entire line is empty.
    const total = COLS;
    return majors.flatMap(major => groups.get(major).sort((a,b) => {
      const rank = reverse ? total-1-major : major;
      return rank % 2 ? b-a : a-b;
    }));
  }
  function applyPatches(root, patches) {
    const parts = path => {
      if (path === '') return [];
      if (typeof path !== 'string' || !path.startsWith('/')) throw Error('상태 경로 오류');
      const keys = path.slice(1).split('/').map(s => s.replace(/~1/g,'/').replace(/~0/g,'~'));
      if (keys.some(k => ['__proto__','constructor','prototype'].includes(k))) throw Error('상태 경로 오류');
      return keys;
    };
    const get = path => parts(path).reduce((v,k) => v?.[k], root);
    const put = (path, value, op) => {
      const keys = parts(path);
      if (!keys.length) { root = op === 'remove' ? null : value; return; }
      const key = keys.pop(), parent = keys.reduce((v,k) => v?.[k], root);
      if (!parent || typeof parent !== 'object') throw Error('상태 동기화 경로가 없습니다.');
      if (Array.isArray(parent)) {
        const index = key === '-' ? parent.length : Number(key);
        if (!Number.isInteger(index) || index < 0 || index > parent.length || (op !== 'add' && index === parent.length)) throw Error('상태 배열 범위 오류');
        if (op === 'add') parent.splice(index,0,value);
        else if (op === 'remove') parent.splice(index,1);
        else parent[index] = value;
      } else if (op === 'remove') delete parent[key];
      else parent[key] = value;
    };
    for (const p of patches) {
      if (p.op === 'test') { if (JSON.stringify(get(p.path)) !== JSON.stringify(p.value)) throw Error('상태 검증 실패'); }
      else if (p.op === 'copy' || p.op === 'move') {
        const value = clone(get(p.from));
        if (p.op === 'move') put(p.from,null,'remove');
        put(p.path,value,'add');
      } else if (['add','replace','remove'].includes(p.op)) put(p.path,p.value,p.op);
      else throw Error('지원하지 않는 상태 변경입니다.');
    }
    return root;
  }
  function mySlot(root, selfId) {
    const slots = root?.child?.data?.userSlots;
    if (!selfId || !Array.isArray(slots)) return null;
    const ids=source=>[source,source?.data].filter(Boolean).flatMap(o=>['userId','id','discordUserId','databaseUserId','playerId']
      .map(key=>o[key]).filter(v=>typeof v==='string'&&v.trim() || finite(v)).map(String));
    const direct=slots.filter(s=>s && ids(s).includes(String(selfId)));
    if(direct.length)return direct.length===1?direct[0]:null;
    const player=root.data?.players?.find(p=>String(p?.id)===String(selfId));
    const accounts=new Set(ids(player).filter(id=>id!==String(selfId) && !id.startsWith('p_')));
    const matches=slots.filter(s=>s && ids(s).some(id=>accounts.has(id)));
    return matches.length===1?matches[0]:null;
  }
  function maxStrength(pet, catalog) {
    const entry = catalog?.pets?.[pet?.petSpecies];
    if (!entry || !finite(entry.maxScale) || !finite(pet?.targetScale)) return null;
    return Math.max(0, Math.floor((entry.maxScale > 1 ? (pet.targetScale-1)/(entry.maxScale-1) : 0)*20+80));
  }
  const mutations = pet => (Array.isArray(pet?.mutations) ? pet.mutations : []).map(m => String(m).toLowerCase());
  function saleReason(pet, inventory, rules, catalog) {
    if (!Array.isArray(inventory?.favoritedItemIds)) return '잠금 정보 대기';
    if (pet?.itemType !== 'Pet' || typeof pet.id !== 'string' || !pet.id) return '펫 아님';
    if (pet.locked || pet.isLocked || pet.favorited || inventory.favoritedItemIds.includes(pet.id)) return '잠금';
    const muts = mutations(pet);
    if (rules.gold && muts.includes('gold')) return 'Gold 보호';
    if (rules.rainbow && muts.includes('rainbow')) return 'Rainbow 보호';
    if (rules.str) {
      const str = maxStrength(pet,catalog);
      if (str === null) return 'STR 확인 대기';
      if (str >= rules.threshold) return `STR ${str} 보호`;
    }
    return '';
  }
  function readyEgg(tile, now = Date.now()) {
    if (String(tile?.objectType).toLowerCase() !== 'egg') return false;
    const value = tile.maturedAt ?? tile.endTime ?? tile.readyAt ?? tile.hatchTime;
    const time = Number(value);
    return time > 0 && Number.isFinite(time) && (time < 1e11 ? time * 1000 : time) <= now;
  }
  function purchaseRecord(shop,record,staleMarker='') {
    const modern=own(shop,'restockId') || own(record,'restockId');
    if(modern) {
      const restockId=shop?.restockId;
      const loaded=typeof restockId==='string' && !!restockId && shop?.open!==false;
      const matches=loaded && record?.restockId===restockId;
      // Old purchase records now survive restocks. Never subtract them from new stock.
      // A newer/mismatched snapshot is unknown: wait for the matching shop frame.
      const older=finite(record?.startedAtMs) && finite(shop?.startedAtMs) && record.startedAtMs<shop.startedAtMs;
      return {modern,restockId,ready:loaded && (!record || matches || older),counts:matches?record.purchases || {}:{},epoch:Number(shop?.startedAtMs || 0)};
    }
    const stale=staleMarker && staleMarker===JSON.stringify(record || {});
    return {modern,restockId:undefined,ready:shop?.open!==false,counts:stale?{}:record?.purchases || {},epoch:Number(record?.createdAt || 0)};
  }
  function stock(root, data, shop, id, staleMarker = '') {
    const value=root?.child?.data?.shops?.[shop];
    const item=Array.isArray(value?.inventory)?value.inventory.find(i=>itemId(i)===id):undefined;
    const record=purchaseRecord(value,data?.shopPurchases?.[shop],staleMarker);
    const bought=Math.max(0,Number(record.counts[id]) || 0);
    return {item,bought,available:record.ready && item && finite(item.initialStock)?Math.max(0,item.initialStock-bought):0,epoch:record.epoch,restockId:record.restockId,ready:record.ready};
  }
  function shopViewMode(page,shop) {
    try {
      const storage=page.localStorage;
      for(let i=0;i<storage.length;i++) {
        const key=storage.key(i),match=/^shop:.*:([^:]+):viewMode$/.exec(key || '');
        if(!match || match[1]!==shop)continue;
        let value=storage.getItem(key);try{value=JSON.parse(value);}catch{}
        if(value==='list' || value==='grid')return value;
      }
    }catch{}
    return 'list';
  }
  const members = team => (Array.isArray(team?.members) ? team.members : []).map(m => String(m?.petId || '')).filter(Boolean).sort();
  // Native v1240 teams are part of the current player's authoritative data.
  const nativeTeams = data => Array.isArray(data?.petTeams) ? data.petTeams.filter(t=>t && typeof t.id==='string' && t.id.trim()) : null;
  function accountKey(root,selfId) {
    const player=root?.data?.players?.find(p=>String(p?.id)===String(selfId)),slot=mySlot(root,selfId);
    for(const key of ['databaseUserId','discordUserId','userId'])for(const obj of [player,player?.data,slot,slot?.data]) {
      const id=obj?.[key];if((typeof id==='string' && id || finite(id)) && !String(id).startsWith('p_'))return String(id);
    }
    return '';
  }
  function requireTeam(data,id) {
    const team=nativeTeams(data)?.find(t=>t.id===id);
    if(!team)throw Error('선택한 펫 팀을 찾을 수 없습니다. 설정에서 팀 목록을 확인하세요.');
    const ids=members(team);
    if(!Array.isArray(team.members) || ids.length!==team.members.length || !ids.length || ids.length>3 || new Set(ids).size!==ids.length)throw Error('선택한 펫 팀의 구성원을 확인할 수 없습니다.');
    return team;
  }
  class NativeGameTeams {
    constructor(page,changed=()=>{}) {this.page=page;this.changed=changed;this.get=null;this.pending=null;this.lastTeams=null;this.unsub=[];}
    atom(label) {
      const cache=this.page.jotaiAtomCache?.cache;
      if(!cache?.entries)return null;
      for(const [key,atom] of cache.entries())if(atom && (atom.debugLabel===label || atom.label===label || String(key).endsWith('/'+label)))return atom;
      return null;
    }
    read(selfId,roomState) {
      if(!this.get)return null;
      try {
        const read=label=>{try{const atom=this.atom(label);return atom?this.get(atom):null;}catch{return null;}};
        const state=read('stateAtom'),root=state?.child?state:state?.state,me=read('playerAtom');
        if(me?.id && selfId && String(me.id)!==String(selfId))return null;
        if(root?.data?.roomSessionId && roomState?.data?.roomSessionId && root.data.roomSessionId!==roomState.data.roomSessionId)return null;
        // These are the game's authoritative own-player atoms, never prediction atoms.
        // They remain usable when stateAtom is absent or exposes a publication wrapper.
        const sources=[nativeTeams(read('myDataAtom')),nativeTeams(read('myUserSlotAtom')?.data),nativeTeams(mySlot(root,me?.id || selfId)?.data)];
        return sources.find(teams=>teams?.length) ?? sources.find(teams=>teams!==null) ?? null;
      }catch{return null;}
    }
    async connect() {
      if(this.get)return true;
      if(this.pending)return this.pending;
      this.pending=this.capture().finally(()=>{this.pending=null;});return this.pending;
    }
    async capture() {
      const cache=this.page.jotaiAtomCache?.cache;if(!cache?.values || !['stateAtom','myDataAtom','myUserSlotAtom'].some(label=>this.atom(label)))return false;
      // Same native stateAtom/playerAtom path used by Arie's server-team watcher.
      // Discover a real game store, without reading Arie's globals or saved settings.
      const hook=this.page.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      for(const [id] of hook?.renderers || [])for(const root of hook.getFiberRoots?.(id) || []) {
        const stack=[root.current],seen=new Set();
        while(stack.length && seen.size<10000) {
          const fiber=stack.pop();if(!fiber || seen.has(fiber))continue;seen.add(fiber);
          for(const store of [fiber.pendingProps?.value,fiber.memoizedProps?.value])if(typeof store?.get==='function' && typeof store.sub==='function') {
            this.get=atom=>store.get(atom);
            const changed=()=>{const teams=this.read();const signature=JSON.stringify(teams);if(signature!==this.lastTeams){this.lastTeams=signature;this.changed();}};
            for(const atom of ['stateAtom','playerAtom','myDataAtom','myUserSlotAtom'].map(label=>this.atom(label)).filter(Boolean))this.unsub.push(store.sub(atom,changed));
            return true;
          }
          stack.push(fiber.child,fiber.sibling,fiber.alternate);
        }
      }
      // Capture only the read accessor during one normal game write, then restore
      // every wrapper. No synthetic game writes and no permanent polling interval.
      return new Promise(resolve=>{
        const patches=[];let settled=false;
        const finish=get=>{
          if(settled)return;settled=true;clearTimeout(timer);
          for(const [atom,original,wrapped] of patches)if(atom.write===wrapped)atom.write=original;
          if(get)this.get=get;resolve(!!get);
        };
        const timer=setTimeout(()=>finish(null),1500);
        for(const atom of cache.values())if(typeof atom?.write==='function') {
          const original=atom.write;
          const wrapped=function(get,...args){finish(get);return original.call(this,get,...args);};
          try{atom.write=wrapped;if(atom.write===wrapped)patches.push([atom,original,wrapped]);}catch{}
        }
        if(!patches.length)finish(null);
      });
    }
  }
  const activeIds = data => (Array.isArray(data?.petSlots) ? data.petSlots : []).map(p => String(p?.id || '')).filter(Boolean).sort();
  const sameIds = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);
  const FEED_THRESHOLD=5;
  function hungerPercent(pet,catalog) {
    const max=catalog.pets?.[pet?.petSpecies]?.coinsToFullyReplenishHunger;
    return finite(max) && max>0 && finite(pet?.hunger) && pet.hunger>=0 ? Math.min(100,pet.hunger/max*100) : null;
  }
  const hungryStage = (pet,catalog) => {
    const percent=hungerPercent(pet,catalog);
    return percent===null || percent>=FEED_THRESHOLD ? '' : percent===0 ? 'empty' : 'low';
  };
  function petFoodGroups(catalog) {
    const seen=new Set();
    const groups=Object.entries(catalog.eggs || {}).sort(([a,x],[b,y])=>
      (finite(x.coinPrice)?x.coinPrice:Infinity)-(finite(y.coinPrice)?y.coinPrice:Infinity) || a.localeCompare(b)).map(([id,egg])=> {
      const weights=Object.entries(egg.faunaSpawnWeights || {}).filter(([,v])=>finite(v)&&v>0);
      const total=weights.reduce((n,[,w])=>n+w,0);
      const pets=weights.filter(([species])=>catalog.pets?.[species]).sort(([a,x],[b,y])=>y-x || a.localeCompare(b)).map(([species,weight])=> {
        seen.add(species);return {species,probability:weight/total*100};
      });
      return {id,pets};
    }).filter(g=>g.pets.length);
    const other=Object.keys(catalog.pets || {}).filter(s=>!seen.has(s)).sort().map(species=>({species,probability:null}));
    if(other.length)groups.push({id:'Other',pets:other});
    return groups;
  }
  const foodKey = (species,type,id) => `${species}:${type}:${id}`;
  const foodAllowed = (settings,species,type,id) =>
    !(type==='Tool' && id==='ReplenishPotion' && settings.feed.hungerPotion===false) && settings.feed.allowed[foodKey(species,type,id)]!==false;
  function chooseFood(data,pet,catalog,settings) {
    const diet=catalog.pets?.[pet.petSpecies]?.diet;
    if(!Array.isArray(diet))return null;
    const produce=i=>i?.itemType==='Produce' && i.id && diet.includes(i.species) && quantity(i)>0 && foodAllowed(settings,pet.petSpecies,'Produce',i.species);
    const potion=i=>i?.itemType==='Tool' && i.toolId==='ReplenishPotion' && quantity(i)>0 && foodAllowed(settings,pet.petSpecies,'Tool','ReplenishPotion');
    const items=data.inventory?.items || [],storages=data.inventory?.storages || [];
    // Locks deliberately do not filter food: the user explicitly enables feeding locked items.
    for(const [test,storageId] of [[produce,'FeedingTrough'],[potion,'ToolShack']]) {
      const item=items.find(test);if(item)return {item};
      const storage=storages.find(s=>(s.decorId || s.id)===storageId);
      const stored=storageItems(storage).find(test);if(stored)return {item:stored,storageId};
    }
    return null;
  }
  function petPosition(data,id,serverNow=null) {
    const info=data.petSlotInfos?.[id],motion=info?.motion;
    let p=motion ? ((!motion.kind || motion.kind==='idle') ? motion.at : null) : info?.position;
    if(!p && Array.isArray(motion?.path) && motion.path.length && finite(serverNow) && finite(motion.startedAtMs) && finite(motion.stepDurationMs) && motion.stepDurationMs>=0 &&
      serverNow>=motion.startedAtMs+motion.stepDurationMs*(motion.path.length-1))p=motion.path.at(-1);
    return finite(p?.x)&&finite(p?.y)?{x:p.x,y:p.y}:null;
  }
  const samePoint=(a,b)=>a && b && a.x===b.x && a.y===b.y;
  const foodLocked=(inventory,item)=>!!item && (item.locked===true || item.isLocked===true || item.favorited===true ||
    (typeof item.id==='string' && inventory.favoritedItemIds?.includes(item.id)));

  class GameLink {
    constructor(page, changed = () => {}) {
      this.page = page; this.changed = changed; this.root = null; this.socket = null;
      this.selfId = ''; this.generation = 0; this.revision = 0; this.pending = new Map(); this.sessions = new WeakMap();
      this.shopWatch = new Map();
      this.serverClock=null;
      this.nativeTeamAttempt=null;this.lastNativeTeam=null;
    }
    install() {
      const link = this, Native = this.page.WebSocket, original = Native.prototype.send;
      Native.prototype.send = function (payload) {
        const session = link.track(this);
        if (this === link.socket && typeof payload === 'string') {
          try {
            const msg = JSON.parse(payload);
            if (msg.type === 'QuinoaCommand') {
              let seq = session.sent.get(msg.requestId);
              if (!seq) {
                seq = Math.max(session.next, Number(msg.commandSequence) || 1);
                session.next = seq+1;
                session.sent.set(msg.requestId,seq);
                if (session.sent.size > 512) session.sent.delete(session.sent.keys().next().value);
              }
              msg.commandSequence=seq;payload = JSON.stringify(msg);
            }
            const command=msg.type==='QuinoaCommand'?msg.command:msg;
            if(command?.type==='ApplyPetTeam' && typeof command.teamId==='string' && command.teamId && !link.pending.has(msg.requestId)) {
              const data=link.data(),known=nativeTeams(data)?.find(t=>t.id===command.teamId);
              link.nativeTeamAttempt={id:command.teamId,requestId:msg.requestId,sequence:msg.commandSequence,at:Date.now(),ack:false,watermark:false,touched:false,before:activeIds(data),expected:known?members(known):null};
              link.lastNativeTeam=null;
              link.changed(undefined,{type:'native-team-request'});
            }
          } catch { /* Non-JSON messages are owned by the game. */ }
        }
        return original.call(this,payload);
      };
      this.page.WebSocket = new Proxy(Native, {
        construct(target,args,newTarget) {
          const socket = Reflect.construct(target,args,newTarget);
          link.track(socket); return socket;
        }
      });
      const existing = this.page.MagicCircle_RoomConnection?.currentWebSocket;
      if (existing) this.track(existing);
    }
    track(socket) {
      if (this.sessions.has(socket)) return this.sessions.get(socket);
      const session = { next: 1, sent: new Map(), chain: Promise.resolve() };
      this.sessions.set(socket,session);
      socket.addEventListener('message', event => {
        // Preserve the wire order even when a browser delivers Blob frames.
        session.chain = session.chain.then(async () => {
          let text = event.data;
          if (typeof text !== 'string') {
            if (typeof text?.text === 'function') text = await text.text();
            else if (text instanceof ArrayBuffer) text = new TextDecoder().decode(text);
            else return;
          }
          let msg; try { msg = JSON.parse(text); } catch { return; }
          this.receive(socket,msg);
        }).catch(() => { if (socket === this.socket) this.invalidate('게임 상태 동기화 실패 · 새로고침이 필요합니다.'); });
      });
      socket.addEventListener('close',() => { if (socket === this.socket) this.invalidate('연결 종료 · 재연결 대기'); });
      return session;
    }
    invalidate(reason) {
      this.root = null; this.generation++;this.serverClock=null;
      this.nativeTeamAttempt=null;this.lastNativeTeam=null;
      for (const p of this.pending.values()) p.error = Error(reason);
      this.changed(reason);
    }
    receive(socket,msg) {
      if (msg.type === 'Welcome' && msg.fullState?.child?.data?.userSlots && typeof msg.selfPlayerId === 'string') {
        this.invalidate('게임 연결 확인'); this.socket = socket; this.root = msg.fullState; this.selfId = msg.selfPlayerId;
        if(finite(msg.publishedAtServerMs))this.serverClock={at:msg.publishedAtServerMs,received:Date.now()};
        this.revision++;
        this.shopWatch.clear(); this.observeShops();
        const session = this.sessions.get(socket); session.next = Math.max(1,Number(msg.executedCommandSequence || 0)+1); session.sent.clear();
        this.changed('게임 연결됨',{type:'ready'}); return;
      }
      if (socket !== this.socket) return;
      if(finite(msg.publishedAtServerMs))this.serverClock={at:msg.publishedAtServerMs,received:Date.now()};
      if (msg.type === 'QuinoaCommandResult') {
        if(this.nativeTeamAttempt?.requestId===msg.requestId && msg.requestId) {
          if(msg.ok===true)this.nativeTeamAttempt.ack=true;
          else {this.nativeTeamAttempt=null;this.changed('게임에서 펫 팀 적용을 거절했습니다.',{type:'native-team-rejected'});}
        }
        const pending = this.pending.get(msg.requestId);
        if (pending) {
          if (msg.ok === true) pending.ack = true;
          else {
            const details = [...new Set([msg.code,msg.message,msg.reason,msg.error?.message]
              .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0,160)))];
            pending.error = Error(failureText(details.join(' · ') || '요청 거부'));
          }
        }
      }
      const patches = msg.type === 'RoomFrame' ? msg.state?.patches : msg.type === 'PartialState' ? msg.patches : null;
      if (this.root && Array.isArray(patches)) {
        this.root = applyPatches(this.root,patches); this.revision++;
        const attempt=this.nativeTeamAttempt;
        if(attempt) {
          const index=this.root.child?.data?.userSlots?.indexOf(mySlot(this.root,this.selfId));
          const prefix=`/child/data/userSlots/${index}`;
          if(index>=0)attempt.touched ||= patches.some(p=>p.path==='' || p.path==='/child' || p.path==='/child/data' || p.path==='/child/data/userSlots' || p.path===prefix || p.path===prefix+'/data' || p.path===prefix+'/data/petSlots' || p.path.startsWith(prefix+'/data/petSlots/'));
        }
        const identityChanged=patches.some(p=>/^\/data(?:\/players(?:\/|$)|$)/.test(p.path) || /^\/child\/data\/userSlots\/\d+(?:\/data)?\/(id|userId|playerId|discordUserId|databaseUserId)(?:\/|$)/.test(p.path));
        const relevant=identityChanged || patches.some(p=>p.path==='' || /^\/child(?:\/data)?$/.test(p.path) || /^\/child\/data\/shops(?:\/|$)/.test(p.path) || /^\/child\/data\/userSlots(?:\/\d+(?:\/data)?)?$/.test(p.path) || /^\/child\/data\/userSlots\/\d+\/data\/(inventory|garden|petTeams|petSlots|coinsCount|shopPurchases)(?:\/|$)/.test(p.path));
        if(relevant) {
          const shopsChanged=identityChanged || patches.some(p=>p.path==='' || /^\/child(?:\/data)?$/.test(p.path) || /^\/child\/data\/shops(?:\/|$)/.test(p.path) || /^\/child\/data\/userSlots(?:\/\d+(?:\/data)?)?$/.test(p.path) || /\/shopPurchases(?:\/|$)/.test(p.path));
          const events=shopsChanged?this.observeShops():{restocked:[],eggPurchases:[]};
          const uiChanged=patches.some(p=>!p.path.endsWith('/secondsUntilRestock'));
          const feedChanged=patches.some(p=>p.path==='' || /^\/child(?:\/data)?$/.test(p.path) || /^\/child\/data\/userSlots(?:\/\d+(?:\/data)?)?$/.test(p.path) || /^\/child\/data\/userSlots\/\d+\/data\/(inventory|petSlots)(?:\/|$)/.test(p.path));
          this.changed(undefined,{type:'state',uiChanged,feedChanged,...events});
        }
      }
      const attempt=this.nativeTeamAttempt;
      if(attempt && Date.now()-attempt.at>10000){this.nativeTeamAttempt=null;this.changed(undefined,{type:'native-team-expired'});return;}
      if(attempt && finite(attempt.sequence) && finite(msg.executedCommandSequence) && msg.executedCommandSequence>=attempt.sequence)attempt.watermark=true;
      if(attempt?.touched) {
        const ids=activeIds(mySlot(this.root,this.selfId)?.data),accountId=accountKey(this.root,this.selfId);
        if(attempt.expected && !sameIds(ids,attempt.expected))return;
        if(!(attempt.ack || attempt.watermark || !sameIds(ids,attempt.before)))return;
        if(accountId && ids.length>=1 && ids.length<=3 && new Set(ids).size===ids.length) {
          this.lastNativeTeam={id:attempt.id,accountId,members:ids.map(petId=>({petId})),generation:this.generation};
          this.nativeTeamAttempt=null;this.changed(undefined,{type:'native-team-confirmed'});
        }
      }
    }
    observeShops() {
      const purchases = mySlot(this.root,this.selfId)?.data?.shopPurchases;
      const events={restocked:[],eggPurchases:[]};
      for (const [shop,value] of Object.entries(this.root?.child?.data?.shops || {})) {
        if (!value) continue;
        const left = Number(value.secondsUntilRestock), marker = JSON.stringify(purchases?.[shop] || {});
        const previous = this.shopWatch.get(shop);
        const snapshot=purchaseRecord(value,purchases?.[shop]);
        const inventorySignature=JSON.stringify(value.inventory||[]);
        const changedInventory=previous && previous.inventorySignature!==inventorySignature;
        const resetDetected = previous && (snapshot.modern ? previous.restockId!==snapshot.restockId : ((Number.isFinite(left) && Number.isFinite(previous.left) && left > previous.left+2) || changedInventory));
        // Inventory and countdown can arrive in separate frames for one restock.
        const restocked=resetDetected && (snapshot.modern || !previous.lastRestockAt || Date.now()-previous.lastRestockAt>3000);
        let stale = previous?.stale || '';
        if(snapshot.modern)stale='';
        else if (restocked && previous.marker === marker) stale = marker;
        if (stale && stale !== marker) stale = '';
        const record=purchaseRecord(value,purchases?.[shop],stale),counts={...record.counts},epoch=record.epoch;
        if(snapshot.modern ? snapshot.ready && (restocked || !previous || !previous.ready || changedInventory) : restocked)events.restocked.push(shop);
        if(previous && !stale)for(const item of Array.isArray(value.inventory)?value.inventory:[]) {
          if(item?.itemType!=='Egg')continue;
          const id=itemId(item),before=(previous.stale || previous.epoch!==epoch || previous.restockId!==snapshot.restockId)?0:Number(previous.counts?.[id]||0);
          if(Number(counts[id]||0)>before)events.eggPurchases.push({shop,id,quantity:Number(counts[id])-before});
        }
        this.shopWatch.set(shop,{left,marker,stale,counts,epoch,restockId:snapshot.restockId,ready:snapshot.ready,inventorySignature,lastRestockAt:restocked?Date.now():previous?.lastRestockAt||0,cycle:(previous?.cycle || 0)+(restocked ? 1 : 0)});
      }
      return events;
    }
    stock(shop,id) {
      const watch = this.shopWatch.get(shop);
      return {...stock(this.root,this.data(),shop,id,watch?.stale),cycle:watch?.cycle || 0};
    }
    serverNow() { return this.serverClock ? this.serverClock.at+Date.now()-this.serverClock.received : null; }
    data() {
      if (!this.root || this.socket?.readyState !== 1) throw Error('게임 연결 대기 · 설치 후 게임 페이지를 새로고침하세요.');
      const data = mySlot(this.root,this.selfId)?.data;
      if (!data?.inventory || !Array.isArray(data.inventory.items)) throw Error('내 인벤토리 동기화 대기');
      return data;
    }
    async command(type,params,predicate,timeout = 12000,{stateConfirms = false,flat = false} = {}) {
      this.data();
      const generation = this.generation, revision = this.revision, requestId = this.page.crypto.randomUUID();
      const pending = { ack: false, error: null }; this.pending.set(requestId,pending);
      try {
        this.socket.send(JSON.stringify(flat ? {scopePath:['Room','Quinoa'],type,...params} : { scopePath: ['Room','Quinoa'], type: 'QuinoaCommand', requestId,
          commandSequence: this.sessions.get(this.socket).next, command: { type,...params } }));
        const deadline = Date.now()+timeout;
        while (Date.now() < deadline) {
          if (pending.error) throw pending.error;
          if (this.generation !== generation) throw Error('연결이 변경되어 작업을 중단했습니다.');
          if ((pending.ack || (stateConfirms && this.revision > revision)) && predicate(this.data())) return;
          await sleep(80);
        }
        throw Error('서버 상태 확인 시간 초과 · 중복 실행을 막기 위해 중단했습니다.');
      } finally { this.pending.delete(requestId); }
    }
  }
  function failureText(code) {
    const detail = code.slice(0,640);
    if (/inventory.*(full|capacity|space)|(full|capacity).*inventory/i.test(code)) return `인벤토리 가득 참 · ${detail}`;
    if (/coin|fund|balance|afford/i.test(code)) return `잔액 부족 · ${detail}`;
    if (/stock|sold.?out/i.test(code)) return `재고 부족 · ${detail}`;
    return `게임 요청 거부: ${detail}`;
  }
  const exported = { settingsFrom,parseSettings,defaults,orderedTiles,applyPatches,mySlot,accountKey,maxStrength,saleReason,readyEgg,stock,purchaseRecord,shopViewMode,GameLink,NativeGameTeams,members,activeIds,sameIds,webhookURL,purchaseCapacity,storagePlan,hungerPercent,hungryStage,petFoodGroups,chooseFood,petPosition };
  if (typeof module === 'object' && module.exports) { module.exports = exported; return; }
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (page.__SNAIL_IN_CHERRY__) return;
  page.__SNAIL_IN_CHERRY__ = VERSION;
  let settings;
  try { settings = settingsFrom(GM_getValue(KEY,defaults())); } catch { settings = defaults(); }
  let catalog = {}, catalogAt = 0, catalogPromise = null, catalogRetryAt = 0, catalogETag = '', running = null, status = '게임 연결 대기', view = 'home';
  let liveInfo={},liveAt=0,livePromise=null,liveRetryAt=0,homePage=0;
  const skinsAPI=()=>page.__SNAIL_WITH_SKINS__;
  function syncSkinsControl() {
    const control=shadow?.querySelector('input[aria-label="스킨·숨기기 전체 적용"]');
    if(control){control.disabled=!skinsAPI()?.setEnabled;control.checked=!!skinsAPI()?.getConfig?.().enabled;}
  }
  function setSkinsEnabled(value) {
    const api=skinsAPI();
    if(!api?.setEnabled){report('스킨 기능 준비 중입니다.');return;}
    Promise.resolve(api.setEnabled(value)).catch(error=>report(error.message));syncSkinsControl();
  }
  function openSkins() {
    const api=skinsAPI();
    if(api?.setPanelOpen){api.setPanelOpen(true);return;}
    // Reuse an already running standalone instance without a second renderer hook.
    const host=document.querySelector('#snail-with-skins'),skinPanel=host?.shadowRoot?.querySelector('.panel');
    if(skinPanel){host.shadowRoot.querySelector('.launcher')?.remove();host.style.zIndex='2147483646';skinPanel.hidden=false;return;}
    report('스킨 UI 준비 중입니다. 잠시 뒤 다시 눌러 주세요.');
  }
  page.addEventListener('snail-with-skins:config-change',syncSkinsControl);
  let panel, content, footer, icon, shadow, lastPaint = 0, paintTimer=null;
  const pendingBuy=new Set();let drainTimer=null,draining=false,readyGeneration=-1;
  const pendingFeed=new Map(),feedStates=new Map();let feedTimer=null,lastFeedAt=0;
  let webhookQueue = Promise.resolve();
  const log = [];
  const save = () => GM_setValue(KEY,settings);
  function report(message) {
    if(status===message)return;
    status = message; log.unshift(`${new Date().toLocaleTimeString('ko-KR')}  ${message}`); log.length = Math.min(log.length,50);
    if (footer) footer.textContent = message;
  }
  const game = new GameLink(page,(message,event) => {
    if (message) report(message);
    if(!game.root) { pendingBuy.clear();clearFeeding();readyGeneration=-1;schedulePaint();return; }
    let data;try{data=game.data();}catch{return;}
    if(readyGeneration!==game.generation) {
      readyGeneration=game.generation;syncEggs();
      void loadCatalog().then(observeFeed);void loadLive();scheduleBuy();schedulePaint();return;
    }
    if(event?.restocked?.length) { scheduleBuy(event.restocked);void loadCatalog();void loadLive(); }
    if(event?.feedChanged)observeFeed();
    if(event?.uiChanged || event?.restocked?.length || event?.type?.startsWith('native-team'))schedulePaint();
    if (footer && footer.textContent!==status) footer.textContent = status;
  });
  game.install();
  const nativeGameTeams=new NativeGameTeams(page,schedulePaint);
  function request(url, options = {}) {
    return new Promise((resolve,reject) => {
      GM_xmlhttpRequest({ method: options.method || 'GET', url, anonymous: true, timeout: 15000,
        headers: options.body ? { 'Content-Type': 'application/json' } : (options.headers||{}), data: options.body,
        onload: response => resolve(response), onerror: () => reject(Error('외부 연결 실패 · 주소와 접근 권한을 확인하세요.')),
        ontimeout: () => reject(Error('외부 연결 시간 초과')) });
    });
  }
  const CATALOG_KEY='snail-in-cherry.catalog.v1';
  try {
    const cached=GM_getValue(CATALOG_KEY,null);
    if(cached?.data?.eggs && cached.data.pets) {catalog=cached.data;catalogAt=Number(cached.at)||0;catalogETag=typeof cached.etag==='string'?cached.etag:'';}
  }catch{}
  function loadCatalog() {
    if(catalogPromise)return catalogPromise;
    if(Date.now()-catalogAt<300000 || Date.now()<catalogRetryAt)return Promise.resolve();
    catalogPromise=fetchCatalog().finally(()=>catalogPromise=null);return catalogPromise;
  }
  async function fetchCatalog() {
    try {
      const response = await request(`${API}/data`,{headers:catalogETag?{'If-None-Match':catalogETag}:{}});
      if(response.status===304) { catalogAt=Date.now();GM_setValue(CATALOG_KEY,{at:catalogAt,etag:catalogETag,data:catalog});return; }
      if (response.status !== 200) throw Error('이미지·품목 API 응답 오류');
      const data = JSON.parse(response.responseText);
      if (!data.eggs || !data.pets) throw Error('품목 API 형식 오류');
      catalog = data; catalogAt = Date.now();catalogRetryAt=0;
      catalogETag=String(response.responseHeaders||'').match(/^etag:\s*(.+)$/im)?.[1]?.trim()||'';
      GM_setValue(CATALOG_KEY,{at:catalogAt,etag:catalogETag,data:catalog});syncEggs();observeFeed();schedulePaint();
    } catch (error) { catalogRetryAt=Date.now()+60000;report(error.message); }
  }
  function loadLive() {
    if(livePromise)return livePromise;
    if(Date.now()-liveAt<60000 || Date.now()<liveRetryAt)return Promise.resolve();
    livePromise=(async()=>{
      try {
        const response=await request(`${API}/live`);
        if(response.status!==200)throw Error('상점 갱신 API 응답 오류');
        const data=JSON.parse(response.responseText);
        if(!data.shops || typeof data.shops!=='object')throw Error('상점 갱신 API 형식 오류');
        liveInfo=data.shops;liveAt=Date.now();liveRetryAt=0;schedulePaint();
      }catch(error){liveRetryAt=Date.now()+60000;report(error.message);}
    })().finally(()=>livePromise=null);return livePromise;
  }
  function schedulePaint() {
    if(!panel || panel.hidden || paintTimer!==null)return;
    paintTimer=setTimeout(()=>{paintTimer=null;refresh();},350);
  }
  function setAutoBuy(value) {
    const was=settings.autoBuy;settings.autoBuy=value;
    if(!value)pendingBuy.clear();
    report(`상점 구매 ${value?'On · 접속·재입고 때 확인':'Off'}`);
    if(value&&!was) {void loadCatalog();void loadLive();scheduleBuy();}
  }
  function scheduleBuy(shops=['*']) {
    if(!settings.autoBuy)return;
    for(const shop of shops)pendingBuy.add(shop);wakeAutomation();
  }
  function clearFeeding() {
    pendingFeed.clear();feedStates.clear();if(feedTimer!==null)clearTimeout(feedTimer);feedTimer=null;
  }
  function setAutoFeed(value) {
    settings.autoFeed=value;clearFeeding();
    report(`펫 먹이 ${value?'On · 배고픔 5% 미만에서 급식':'Off'}`);
    if(value)void loadCatalog().then(observeFeed);
  }
  function observeFeed() {
    if(!settings.autoFeed || !game.root || ['feed','hatch','sell'].includes(running?.kind))return;
    let pets;try{pets=(game.data().petSlots || []).filter(Boolean).slice(0,3);}catch{return;}
    const ids=new Set(pets.map(p=>p.id));
    for(const id of pendingFeed.keys())if(!ids.has(id))pendingFeed.delete(id);
    for(const pet of pets) {
      if(!pet.id)continue;
      const stage=hungryStage(pet,catalog);
      if(!stage){feedStates.delete(pet.id);pendingFeed.delete(pet.id);continue;}
      let state=feedStates.get(pet.id);
      if(!state || state.stage!==stage) {
        state={stage,complete:false,waiting:false};feedStates.set(pet.id,state);
        report(`${pet.name || title('Pet',pet.petSpecies)} · 배고픔 알림 (${hungerPercent(pet,catalog).toFixed(1)}%)`);
        notifyFeed(pet,'배고픔 알림',`배고픔 ${hungerPercent(pet,catalog).toFixed(1)}% · 1~5초 후 급식 대기`);
      }
      if(state.complete || pendingFeed.has(pet.id))continue;
      if(state.waiting && !chooseFood(game.data(),pet,catalog,settings))continue;
      state.waiting=false;
      pendingFeed.set(pet.id,{id:pet.id,species:pet.petSpecies,hunger:pet.hunger,due:Date.now()+1000+Math.floor(Math.random()*4001)});
    }
    armFeedTimer();
  }
  function readyFeed() {
    if(!settings.autoFeed || Date.now()<lastFeedAt+2000)return null;
    return [...pendingFeed.values()].find(entry=>entry.due<=Date.now()) || null;
  }
  function armFeedTimer() {
    if(feedTimer!==null)clearTimeout(feedTimer);feedTimer=null;
    if(!settings.autoFeed || !pendingFeed.size || running || draining)return;
    const due=Math.max(lastFeedAt+2000,Math.min(...[...pendingFeed.values()].map(e=>e.due)));
    feedTimer=setTimeout(()=>{feedTimer=null;wakeAutomation();},Math.max(0,due-Date.now()));
  }
  function wakeAutomation() {
    if(drainTimer!==null || draining || running || !game.root)return;
    if(!pendingBuy.size && !readyFeed()){armFeedTimer();return;}
    // Coalesce shop updates and multi-unit purchases arriving in one short burst.
    drainTimer=setTimeout(()=>{drainTimer=null;void drainAutomation();},readyFeed()?0:200);
  }
  async function drainAutomation() {
    if(draining || running || !game.root)return;
    draining=true;
    try {
      const feed=readyFeed();
      if(feed) {
        pendingFeed.delete(feed.id);
        await run('feed',job=>feedPet(job,feed));
      }else if(pendingBuy.size) {
        const shops=new Set(pendingBuy);pendingBuy.clear();
        const generation=game.generation;
        if(settings.autoBuy) {await loadCatalog();if(settings.autoBuy && generation===game.generation)await run('buy',job=>buy(job,shops));}
      }
    }finally{draining=false;wakeAutomation();}
  }
  function meta(type,id) {
    return type === 'Produce' ? catalog.plants?.[id]?.crop || {} : type === 'Seed' ? catalog.plants?.[id]?.seed || {} :
      catalog[{ Egg:'eggs',Tool:'items',Decor:'decor',Pet:'pets' }[type]]?.[id] || {};
  }
  function sprite(type,id) {
    try {
      const url = new URL(meta(type,id).sprite);
      return url.protocol === 'https:' && url.hostname === 'mg-api.ariedam.fr' ? url.href : '';
    } catch { return ''; }
  }
  const title = (type,id) => meta(type,id).name || id;
  function notifyPurchase(type,id,sent,confirmed,reason) {
    if (!settings.webhook.enabled || !settings.webhook.url) return;
    const image = sprite(type,id);
    const embed = { title: confirmed === sent && !reason ? '🛒 구매 완료' : '🛒 구매 결과',
      description: `${title(type,id)}\n구매 성공 재고 ${confirmed}/${sent}${reason ? `\n${reason}` : ''}`,
      color: reason ? 0xf0ad4e : 0xb34465, footer: { text: 'Snail in Cherry' }, timestamp: new Date().toISOString() };
    if (image) embed.thumbnail = { url: image };
    sendWebhook(settings.webhook,embed);
  }
  function notifyFeed(pet,event,detail) {
    const embed={title:`🍽️ ${event}`,description:`${pet.name || title('Pet',pet.petSpecies)}\n${detail}`,color:0x67987b,footer:{text:'Snail in Cherry'},timestamp:new Date().toISOString()};
    const image=sprite('Pet',pet.petSpecies);if(image)embed.thumbnail={url:image};
    sendWebhook(settings.feed.webhook,embed);
  }
  function sendWebhook(hook,embed) {
    if(!hook.enabled || !hook.url)return;
    const url=webhookURL(hook.url);
    const body = JSON.stringify({ username: 'Snail in Cherry', allowed_mentions: { parse: [] }, embeds: [embed] });
    webhookQueue = webhookQueue.then(async () => {
      for (let attempt=0; attempt<3; attempt++) {
        const response = await request(url,{ method:'POST',body });
        if (response.status >= 200 && response.status < 300) return;
        if (response.status === 429 && attempt < 2) {
          let seconds = 2; try { seconds = Number(JSON.parse(response.responseText).retry_after) || 2; } catch {}
          await sleep(Math.min(60000,Math.max(1000,seconds*1000))); continue;
        }
        throw Error(`웹후크 전송 실패 (${response.status})`);
      }
    }).catch(error => report(error.message));
  }
  function syncEggs() {
    const all = new Set(Object.keys(catalog.eggs || {}));
    try { for (const i of game.data().inventory.items) if (i?.itemType === 'Egg') all.add(i.eggId); } catch {}
    let changed = false;
    for (const id of all) if (id && !settings.eggs.order.includes(id)) { settings.eggs.order.push(id); changed = true; }
    if (changed) save();
  }
  const countEgg = (data,id) => data.inventory.items.reduce((n,i) => n+(i?.itemType === 'Egg' && i.eggId === id ? quantity(i) : 0),0);
  function garden(data) {
    if (!data.garden?.tileObjects || typeof data.garden.tileObjects !== 'object') throw Error('밭 정보 동기화 대기');
    return data.garden.tileObjects;
  }
  function checkJob(job, restoring = false) {
    if (game.generation !== job.generation) throw Error('연결이 변경되어 작업을 중단했습니다.');
    if (!restoring && (job.cancel || (job.kind === 'buy' && !settings.autoBuy) || (job.kind==='feed' && !settings.autoFeed))) throw Error('작업 중지');
    game.data();
  }
  async function run(kind,action) {
    if (running) { report('진행 중인 작업이 끝난 뒤 실행하세요.'); return; }
    const job = { kind,generation:game.generation,cancel:false };
    running = job; refresh();
    try { game.data(); await action(job); }
    catch(error) {
      report(error.message+(kind==='buy' && settings.autoBuy?' · 입고 시 구매 On 유지 · 다음 입고·재접속 때 재확인':''));
    } finally { running = null; observeFeed();refresh();wakeAutomation(); }
  }
  async function feedPet(job,entry) {
    const state=feedStates.get(entry.id);if(state)state.complete=true;
    const current=()=>game.data().petSlots?.find(p=>p?.id===entry.id && p.petSpecies===entry.species);
    let pet=current();
    if(!pet || !hungryStage(pet,catalog) || pet.hunger>entry.hunger)return;
    const recipient={...pet};
    const notice=(event,message)=>{report(`${recipient.name || title('Pet',recipient.petSpecies)} · ${message}`);notifyFeed(recipient,event,message);};
    let selected=chooseFood(game.data(),pet,catalog,settings);
    if(!selected) {
      if(state){state.complete=false;state.waiting=true;}
      notice('급식 대기','사용 가능한 먹이 없음 · 먹이 입고 시 다시 확인');return;
    }
    let unlockedId=null;
    let food=selected.item;
    const canFeedSelected=()=> {
      checkJob(job);pet=current();
      if(!pet || !hungryStage(pet,catalog) || pet.hunger>entry.hunger)return false;
      if(foodAllowed(settings,pet.petSpecies,food.itemType,food.species || food.toolId))return true;
      if(state){state.complete=false;state.waiting=true;}
      notice('급식 취소','먹이 선택 변경 · 선택한 먹이 급식 취소');
      return false;
    };
    let moveDeadline=0,moves=0;
    async function preparePotion() {
      // /data supplies item metadata, not use requirements. Confirm the live game's
      // co-location requirement before and after unlocking; never chase a pet indefinitely.
      if(!moveDeadline)moveDeadline=Date.now()+8000;
      while(true) {
        if(!canFeedSelected())return false;
        const position=petPosition(game.data(),entry.id,game.serverNow());
        if(position && samePoint(game.data().position,position))return true;
        if(Date.now()>=moveDeadline)throw Error('펫 위치·이동 확인 대기 · 포션 미사용');
        if(!position){await sleep(100);continue;}
        if(moves>=2)throw Error('펫이 계속 이동하여 포션 사용 보류');
        moves++;
        await game.command('Teleport',{position},next=>samePoint(next.position,position),moveDeadline-Date.now(),{flat:true,stateConfirms:true});
      }
    }
    try {
      checkJob(job);
      if(selected.storageId) {
        const data=game.data();
        if(data.inventory.items.filter(Boolean).length>=CAPACITY)throw Error('인벤토리 가득 참 · 먹이를 꺼낼 수 없습니다.');
        const key=moveItemKey(food),prior=quantity(food);
        if(!key)throw Error('먹이 이동 식별자 확인 대기');
        // Food UUIDs are retained by retrieval; potions may merge into an existing stack.
        const owned=food.itemType==='Tool'?purchaseCapacity(data,food).held:quantity(data.inventory.items.find(i=>i?.id===food.id) || {quantity:0});
        await game.command('MoveItem',{from:selected.storageId,to:'inventory',itemId:key,quantity:1},next=> {
          const source=next.inventory.storages?.find(s=>(s.decorId || s.id)===selected.storageId);
          const left=storageItems(source).find(i=>moveItemKey(i)===key);
          const now=food.itemType==='Tool'?purchaseCapacity(next,food).held:quantity(next.inventory.items.find(i=>i?.id===food.id) || {quantity:0});
          return now>owned && (!left || quantity(left)<prior);
        },12000,{stateConfirms:true});
        food=game.data().inventory.items.find(i=>food.itemType==='Tool'?i?.toolId===food.toolId:i?.id===food.id);
        if(!food)throw Error('꺼낸 먹이 확인 실패');
      }
      if(!canFeedSelected())return;
      if(foodLocked(game.data().inventory,food) && (typeof food.id!=='string' || !food.id))throw Error('먹이 개별 ID 확인 대기 · 잠금 유지');
      if(food.itemType==='Tool' && !await preparePotion())return;
      if(!canFeedSelected())return;
      // Only the selected item's own ID may be unlocked; species/tool IDs are never lock keys.
      const inv=game.data().inventory;
      if(!Array.isArray(inv.favoritedItemIds))throw Error('먹이 잠금 정보 확인 대기');
      const candidate=inv.items.find(i=>food.id ? i?.id===food.id : i?.itemType==='Tool' && i.toolId===food.toolId);
      if(!candidate || quantity(candidate)<=0)throw Error('선택한 먹이가 없어 급식 보류');
      if(foodLocked(inv,candidate)) {
        if(typeof candidate.id!=='string' || !candidate.id)throw Error('먹이 개별 ID 확인 대기 · 잠금 유지');
        unlockedId=candidate.id;
        await game.command('ToggleLockItem',{itemId:unlockedId},next=> {
          const selected=next.inventory.items.find(i=>i?.id===unlockedId);
          return !!selected && !foodLocked(next.inventory,selected);
        },12000,{stateConfirms:true});
      }
      if(food.itemType==='Tool' && !await preparePotion())return;
      if(!canFeedSelected())return;
      const dataBefore=game.data(),potion=food.itemType==='Tool';
      if(potion && !samePoint(dataBefore.position,petPosition(dataBefore,entry.id,game.serverNow())))throw Error('펫이 이동하여 포션 사용 보류');
      const selectedNow=dataBefore.inventory.items.find(i=>potion?i?.itemType==='Tool' && i.toolId===food.toolId:i?.id===food.id);
      if(!selectedNow || (food.id && selectedNow.id!==food.id) || quantity(selectedNow)<=0 || foodLocked(dataBefore.inventory,selectedNow))throw Error('먹이 수량·잠금·선택 변경 · 급식 보류');
      const countSelected=next=>food.id ? quantity(next.inventory.items.find(i=>i?.id===food.id) || {quantity:0}) : purchaseCapacity(next,food).held;
      const beforeHunger=pet.hunger,beforeCount=countSelected(dataBefore);
      lastFeedAt=Date.now();
      await game.command(potion?'ReplenishPotion':'FeedPet',potion?{petItemId:pet.id}:{petItemId:pet.id,cropItemId:food.id},next=> {
        const after=next.petSlots?.find(p=>p?.id===pet.id);
        const remaining=countSelected(next);
        return finite(after?.hunger) && after.hunger>beforeHunger && remaining<beforeCount;
      },12000,{stateConfirms:true});
      notice('급식 완료',`${title(potion?'Tool':'Produce',potion?food.toolId:food.species)} 1개 지급 확인`);
    }catch(error){
      notice('급식 중단',error.message);
    }finally{
      if(unlockedId) {
        try {
          checkJob(job,true);
          const inv=game.data().inventory;
          const remaining=[...inv.items,...(inv.storages || []).flatMap(storageItems)].find(i=>i?.id===unlockedId);
          if(remaining && !foodLocked(inv,remaining))
            await game.command('ToggleLockItem',{itemId:unlockedId},next=> {
              const same=[...next.inventory.items,...(next.inventory.storages || []).flatMap(storageItems)].find(i=>i?.id===unlockedId);
              return !!same && foodLocked(next.inventory,same);
            },12000,{stateConfirms:true});
        }catch(error){notice('잠금 복구 확인 필요',error.message);}
      }
    }
  }
  async function buy(job,shops=new Set(['*'])) {
    let attempted = false, capped = false;
    const rows = shopRows().filter(row => (shops.has('*')||shops.has(row.shop)) && settings.buy[choiceKey(row.item)] && row.available > 0);
    for (const row of rows) {
      checkJob(job);
      if (!settings.buy[choiceKey(row.item)]) continue;
      const capacity=purchaseCapacity(game.data(),row.item,meta(row.item.itemType,row.id));
      if (!capacity.remaining) {
        capped=true;
        report(`${title(row.item.itemType,row.id)} · 소지 한도 ${capacity.held}/${capacity.limit} · 구매 건너뜀`);
        continue;
      }
      if (attempted) {
        const until = Date.now()+1000+Math.floor(Math.random()*2001);
        while (Date.now() < until) { checkJob(job); await sleep(100); }
      }
      checkJob(job); attempted = true;
      const { shop,id,item } = row, type = item.itemType;
      let sent=0,confirmed=0,reason='',storageNote='';
      const heldBefore=purchaseCapacity(game.data(),item,meta(type,id)).held;
      const initial = game.stock(shop,id);
      const target = initial.available;
      try {
        do {
          checkJob(job);
          if (!settings.buy[choiceKey(item)]) break;
          const data = game.data(), before = game.stock(shop,id);
          const capacity=purchaseCapacity(data,before.item || item,meta(type,id));
          if (!capacity.remaining) { reason=`소지 한도 ${capacity.held}/${capacity.limit} · 추가 구매 건너뜀`; break; }
          if (!before.available) { reason='재고 부족'; break; }
          if (before.cycle !== initial.cycle) { reason='재입고 감지 · 다음 검사에서 계속'; break; }
          const price = before.item.coinPrice ?? meta(type,id).coinPrice;
          const affordable=finite(price) && price>0 && finite(data.coinsCount)?Math.floor(data.coinsCount/price):Infinity;
          const amount=Math.max(0,Math.floor(Math.min(before.available,capacity.remaining,affordable)));
          if (!amount) { reason='잔액 부족'; break; }
          if (data.inventory.items.filter(Boolean).length >= CAPACITY && !data.inventory.items.some(i => i?.itemType === type && itemId(i) === id)) { reason='인벤토리 가득 참'; break; }
          if(amount<target)reason=capacity.remaining<=affordable?'소지 한도에 맞춰 구매':'잔액에 맞춰 구매';
          report(`${title(type,id)} 모두 구매 중 · ${amount}개`);
          sent=amount;
          // Arie's Mod 3.2.219 ShopsService.buy: one command carries the full quantity.
          // Like the game, omit quantity for a single unit. Never retry an unconfirmed batch.
          await game.command('PurchaseShopItem',{ shop,viewMode:shopViewMode(page,shop),item:{ itemType:type,[FIELDS[type]]:id },...(amount===1?{}:{quantity:amount}) },next => {
            const after = game.stock(shop,id);
            if(after.cycle!==before.cycle || after.restockId!==before.restockId)return false;
            confirmed=Math.max(confirmed,Math.max(0,Math.min(amount,after.bought-before.bought,purchaseCapacity(next,item,meta(type,id)).held-capacity.held)));
            return confirmed===amount;
          });
        } while(false);
      } catch(error) {
        reason=error.message;
        throw Error(`${title(type,id)} 구매 실패 (${shop}/${id}) · ${reason}`);
      }
      finally {
        if(settings.autoStore && confirmed>0 && !job.cancel && job.generation===game.generation) {
          try { storageNote=await storePurchased(job,item,confirmed,heldBefore); }
          catch(error) { storageNote=`보관함 이동 중단 · ${error.message}`; }
        }
        if (sent) notifyPurchase(type,id,sent,confirmed,reason);
        report(`${title(type,id)} · 구매 확인 ${confirmed}개${reason ? ` · ${reason}` : ''}${storageNote ? ` · ${storageNote}` : ''}`);
      }
      checkJob(job);
    }
    if (!attempted && !capped) report(shopRows().some(r=>settings.buy[choiceKey(r.item)] && !r.ready)?'상점 구매 대기 · 최신 입고 정보 동기화 중':'상점 구매 대기 · 선택 품목 재고 없음');
  }
  async function plant(job) {
    syncEggs(); let done=0;
    for (const slot of orderedTiles(settings.eggs.direction)) {
      checkJob(job);
      const data=game.data(), tiles=garden(data);
      if (tiles[slot]) continue;
      const id=settings.eggs.order.find(id => settings.eggs.enabled[id] && countEgg(data,id)>0);
      if (!id) { report(`알 심기 종료 · 선택한 알 재고 없음${done ? ` · ${done}개 심음` : ''}`); return; }
      const before=countEgg(data,id);
      await game.command('GrowEgg',{ slot,eggId:id },next => {
        const tile=garden(next)[slot];
        return tile?.objectType === 'egg' && tile.eggId === id && countEgg(next,id)<before;
      });
      report(`알 심기 · ${++done}개 완료`);
    }
    report(`알 심기 종료 · 밭에 빈칸 없음${done ? ` · ${done}개 심음` : ''}`);
  }
  async function storePurchased(job,item,purchased,heldBefore) {
    let moved=0;
    while(moved<purchased && settings.autoStore) {
      checkJob(job);
      const plan=storagePlan(game.data(),item,purchased-moved,heldBefore,catalog.decor?.[STORAGE_FOR[item.itemType]]);
      if(!plan.storage)return [moved?`보관함 ${moved}개 이동`:'',plan.reason].filter(Boolean).join(' · ');
      const before=storageCount(plan.storage,item);
      await game.command('MoveItem',{from:'inventory',to:plan.storageId,itemId:plan.itemKey,quantity:plan.amount},next=> {
        const storage=next.inventory.storages?.find(s=>(s?.decorId || s?.id)===plan.storageId);
        return storageCount(storage,item)>=before+plan.amount && purchaseCapacity(next,item).held<=plan.held-plan.amount;
      },12000,{stateConfirms:true});
      moved+=plan.amount;
    }
    return moved ? `보관함 ${moved}개 이동` : '';
  }
  async function applyTeam(id,job,restore = false) {
    if (!id) return;
    checkJob(job,restore);
    const data=game.data(), team=requireTeam({...data,petTeams:teamSnapshot()},id);
    const ids=members(team);
    if (sameIds(activeIds(data),ids)) return;
    report(`${restore ? '프리셋 복구' : '프리셋 적용'} · ${team.name || id}`);
    await game.command('ApplyPetTeam',{ teamId:id },next => sameIds(activeIds(next),ids),12000,{stateConfirms:true});
  }
  async function withTeam(kind,job,action) {
    await nativeGameTeams.connect();checkJob(job);
    const data={...game.data(),petTeams:teamSnapshot()}, target=settings.teams[kind];
    const original=(nativeTeams(data) || []).find(t => sameIds(members(t),activeIds(data)));
    const restore=settings.teams.restore === 'current' ? String(original?.id || '') : settings.teams.restore;
    if (target && settings.teams.restore === 'current' && !restore) throw Error('현재 구성이 저장된 펫 팀과 일치하지 않습니다. 게임에서 팀을 저장하거나 복구 팀을 선택하세요.');
    // Keep saved selections through initial/delayed snapshots, but never run an
    // action when its target or recovery team is unavailable.
    if(target)requireTeam(data,target);
    if(restore)requireTeam(data,restore);
    let changed=false;
    try {
      if (target) { changed=true; await applyTeam(target,job); }
      await action();
    } finally {
      if (restore && (changed || settings.teams.restore !== 'current')) await applyTeam(restore,job,true);
    }
  }
  function hatchAll() { void hatch(); }
  async function hatch(eggId = '') {
    await run('hatch',async job => {
      const initial=garden(game.data());
      const slots=orderedTiles(settings.eggs.direction,Object.keys(initial).map(Number))
        .filter(slot => readyEgg(initial[slot]) && (!eggId || initial[slot].eggId === eggId))
        .map(slot => ({ slot, signature:JSON.stringify(initial[slot]) }));
      if (!slots.length) { report('부화 가능한 알이 없습니다.'); return; }
      let done=0;
      await withTeam('hatch',job,async () => {
        for (const target of slots) {
          checkJob(job);
          const data=game.data(), tile=garden(data)[target.slot];
          if (!readyEgg(tile) || JSON.stringify(tile) !== target.signature) continue;
          if (data.inventory.items.filter(Boolean).length >= CAPACITY) throw Error(`인벤토리 가득 참 · ${done}개 부화 완료`);
          const petIds=new Set(data.inventory.items.filter(i => i?.itemType === 'Pet').map(i => i.id));
          await game.command('HatchEgg',{ slot:target.slot },next => JSON.stringify(garden(next)[target.slot]) !== target.signature &&
            next.inventory.items.some(i => i?.itemType === 'Pet' && !petIds.has(i.id)),12000,{stateConfirms:true});
          report(`알 부화 · ${++done}/${slots.length}`);
        }
      });
      report(`알 부화 완료 · ${done}개`);
    });
  }
  async function sell() {
    await run('sell',async job => {
      const rules=clone(settings.protect), data=game.data();
      if (!Array.isArray(data.inventory.favoritedItemIds)) throw Error('잠금 정보 동기화 대기');
      const targets=data.inventory.items.filter(p => !saleReason(p,data.inventory,rules,catalog)).map(clone);
      if (!targets.length) { report('판매 대상 펫이 없습니다.'); return; }
      const rainbows=targets.filter(p => mutations(p).includes('rainbow'));
      if (rainbows.length && !await askRainbow(rainbows)) { report('판매 취소'); return; }
      checkJob(job); let done=0,skipped=0;
      await withTeam('sell',job,async () => {
        const requests=[];let dispatchError=null;
        try { for (const target of targets) {
          checkJob(job);
          const next=game.data(), current=next.inventory.items.find(p => p?.id === target.id);
          // Snapshot IDs prevent newly arriving pets from joining an approved sale.
          if (!current || saleReason(current,next.inventory,rules,catalog)) { skipped++; continue; }
          if (mutations(current).includes('rainbow') && !rainbows.some(p => p.id === current.id)) { skipped++; continue; }
          // Dispatch the authorized snapshot like the game's bulk-sale flow.
          // Do not let one delayed/missing per-command ACK block the next pet.
          // Each request still needs that exact ID to disappear from server state.
          requests.push(game.command('SellPet',{ itemId:current.id },after => !after.inventory.items.some(p => p?.id === current.id),12000,{stateConfirms:true})
            .then(()=>{report(`펫 판매 · ${++done}/${targets.length}마리 확인`);return {ok:true};},error=>({ok:false,error})));
          // Snail's Mod uses a short 20ms gap and re-reads each target's locks.
          await sleep(20);
        } } catch(error) { dispatchError=error; }
        const results=await Promise.all(requests),failures=results.filter(result=>!result.ok);
        if(failures.length)throw Error(`펫 판매 ${done}마리 확인 · ${failures.length}마리 미확인 · ${failures[0].error.message}`);
        if(dispatchError)throw Error(`펫 판매 ${done}마리 확인 · ${dispatchError.message}`);
      });
      report(`펫 판매 완료 · ${done}마리${skipped ? ` · 제외 ${skipped}마리` : ''}`);
    });
  }
  function shopRows() {
    let data; try { data=game.data(); } catch { return []; }
    return Object.entries(game.root.child.data.shops || {}).flatMap(([shop,value]) =>
      (Array.isArray(value?.inventory)?value.inventory:[]).filter(i => FIELDS[i?.itemType] && itemId(i)).map(item => {
        const id=itemId(item); return { shop,id,item,...game.stock(shop,id) };
      }));
  }
  // All external strings are assigned as text, never interpreted as HTML/code.
  function el(tag,props={},...children) {
    const node=document.createElement(tag);
    for (const [key,value] of Object.entries(props)) {
      if (key === 'class') node.className=value;
      else if (key === 'text') node.textContent=value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2),value);
      else if (key === 'ariaLabel') node.setAttribute('aria-label',value);
      else node[key]=value;
    }
    for (const child of children.flat()) if (child != null) node.append(child);
    return node;
  }
  const button = (text,onclick,cls='') => el('button',{ type:'button',text,onclick,class:cls });
  function switchFor(value,change,label) {
    return el('label',{ class:'switch',title:label },el('input',{ type:'checkbox',checked:value,ariaLabel:label,
      onchange:event => { change(event.target.checked); save(); } }),el('span'));
  }
  function row(label,control,sub='') {
    return el('div',{ class:'row' },el('div',{ class:'grow' },el('div',{ text:label,class:'label' }),sub ? el('small',{ text:sub }) : null),control);
  }
  function select(value,options,change,label) {
    const node=el('select',{ ariaLabel:label,onchange:event => { change(event.target.value); save(); } },
      options.map(([id,name]) => el('option',{ value:id,text:name })));
    node.value=value; return node;
  }
  function itemLabel(type,id,subtitle) {
    const url=sprite(type,id);
    return el('div',{ class:'item' },url ? el('img',{ src:url,alt:'',loading:'lazy',onerror:event => event.target.hidden=true }) : el('span',{ text:type==='Egg'?'🥚':'✦',class:'fallback' }),
      el('div',{ class:'grow' },el('div',{ text:title(type,id),class:'label' }),el('small',{ text:subtitle })));
  }
  function go(next) {
    dragEgg=''; shadow?.activeElement?.blur(); view=next; refresh(true);
    if(next==='settings')void refreshNativeTeams();
  }
  function refresh(force = false) {
    if (!content) return;
    syncSkinsControl();
    shadow.querySelector('.connection').textContent=game.root?'● 연결됨':'○ 연결 대기';
    shadow.querySelector('.stop').hidden=!running;
    placePanel();
    // Team options must still follow server patches while a select or text field
    // has focus. Update these controls in place without discarding the user's edit.
    if(view==='settings')syncTeamControls();
    // Background work must not replace an input while the user is editing it.
    if (!force && (dragEgg || (content.contains(shadow.activeElement) && ['INPUT','SELECT'].includes(shadow.activeElement?.tagName)))) return;
    lastPaint=Date.now(); content.replaceChildren();
    panel.classList.toggle('home',view==='home');
    const names={ home:'내 정원',buy:'상점 구매',plant:'알 심기',hatch:'알 부화',sell:'펫 판매',feed:'펫 먹이',settings:'설정' };
    shadow.querySelector('.page-name').textContent=names[view];
    const back=shadow.querySelector('.back'); back.hidden=view==='home';
    if (view==='home') {
      if(homePage===0)for (const [key,name,glyph] of [['buy','상점 구매','🛒'],['plant','알 심기','🥚'],['hatch','알 부화','🐣'],['sell','펫 판매','🐾'],['feed','펫 먹이','🍽️'],['settings','설정','⚙️']]) {
        const control=key==='feed'?switchFor(settings.autoFeed,setAutoFeed,'펫 먹이 자동 지급'):key==='buy' ? switchFor(settings.autoBuy,setAutoBuy,'입고 시 구매') :
          button(key==='plant'?'심기':key==='hatch'?'부화':key==='sell'?'판매':'⚙️',() => key==='plant'?void run('plant',plant):key==='hatch'?hatchAll():key==='sell'?void sell():go('settings'),'pill');
        content.append(el('div',{ class:'menu-row' },button(`${glyph}  ${name}`,()=>go(key),'menu-link'),control));
      }
      if(homePage===1)content.append(el('div',{class:'menu-row'},button('📷 숨기기',openSkins,'menu-link'),
        switchFor(!!skinsAPI()?.getConfig?.().enabled,setSkinsEnabled,'스킨·숨기기 전체 적용')));
      content.append(el('nav',{class:'rooms',ariaLabel:'방 이동'},...[
        ['연화','Yeonhwa'],['채리','Cherry'],['혜','Hye']
      ].map(([name,room])=>el('a',{text:name,href:`https://magicgarden.gg/r/${room.toLowerCase()}`,title:`${room} 방으로 이동`} ))));
      const previous=button('◀',()=>{homePage=0;refresh(true);});previous.setAttribute('aria-label','이전 메뉴 페이지');previous.disabled=homePage===0;
      const next=button('▶',()=>{homePage=1;refresh(true);});next.setAttribute('aria-label','다음 메뉴 페이지');next.disabled=homePage===1;
      content.append(el('nav',{class:'menu-pages',ariaLabel:'메뉴 페이지 전환'},previous,el('span',{text:`${homePage+1} / 2`}),next));
      syncSkinsControl();
    } else {
      if (view==='buy') renderBuy();
      if (view==='plant') renderPlant();
      if (view==='hatch') renderHatch();
      if (view==='sell') renderSell();
      if (view==='feed') renderFeed();
      if (view==='settings') renderSettings();
    }
    if(footer.textContent!==status)footer.textContent=status;
    placePanel();
  }
  function renderBuy() {
    content.append(row('입고 시 구매',switchFor(settings.autoBuy,setAutoBuy,'입고 시 구매'),'접속·On·재입고 때 확인 · 품목 사이 1~3초'),
      row('보관함 자동 이동',switchFor(settings.autoStore,v=>settings.autoStore=v,'보관함 자동 이동'),'이 스크립트로 구매한 수량만 이동합니다.'));
    const rows=shopRows(), entries=new Map();
    for (const [type,source] of [['Seed',catalog.plants],['Egg',catalog.eggs],['Tool',catalog.items],['Decor',catalog.decor]]) {
      for (const id of Object.keys(source || {})) {
        const entry=meta(type,id);
        if (entry.coinPrice != null) entries.set(`${type}:${id}`,{type,id});
      }
    }
    for (const r of rows) entries.set(choiceKey(r.item),{type:r.item.itemType,id:r.id});
    for (const key of Object.keys(settings.buy)) {
      const [type,id]=key.split(':'); if (FIELDS[type] && id) entries.set(key,{type,id});
    }
    for (const type of ['Seed','Egg','Tool','Decor']) {
      const group=[...entries.values()].filter(e=>e.type===type);
      if (!group.length) continue;
      const selected=group.filter(({id})=>settings.buy[`${type}:${id}`]).length;
      const category=el('details',{ class:'shop-category',open:!settings.collapsedShops.includes(type) });
      category.dataset.category=type;
      category.append(el('summary',{},el('span',{text:({Seed:'씨앗',Egg:'알',Tool:'도구',Decor:'장식'})[type]}),el('small',{text:`선택 ${selected} / ${group.length}`})));
      category.addEventListener('toggle',()=>{
        // Ignore delayed toggle events from nodes replaced during a page change.
        if(!category.isConnected)return;
        settings.collapsedShops=settings.collapsedShops.filter(value=>value!==type);
        if(!category.open)settings.collapsedShops.push(type);
        save();placePanel();
      });
      const categoryBody=el('div',{class:'category-body'});category.append(categoryBody);
      const shopKey=({Seed:'seed',Egg:'egg',Tool:'tool',Decor:'decor'})[type];
      const nextAt=Date.parse(liveInfo[shopKey]?.nextRestockAt);
      if(Number.isFinite(nextAt))categoryBody.append(el('small',{text:`다음 갱신 ${new Date(nextAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}${nextAt<Date.now()?' · 서버 갱신 확인 대기':''}`}));
      for (const {id} of group) {
        const key=`${type}:${id}`, available=rows.filter(r=>r.id===id && r.item.itemType===type).reduce((n,r)=>n+r.available,0);
        let held='—',breakdown='';try{
          const data=game.data(),item={itemType:type,[FIELDS[type]]:id},inventory=purchaseCapacity(data,item).held;
          const stored=(data.inventory.storages || []).reduce((n,s)=>n+storageCount(s,item),0);
          held=inventory+stored;breakdown=`인벤토리 ${inventory} · 보관함 ${stored}`;
        }catch{}
        const label=itemLabel(type,id,`재고 ${available} · 보유 ${held}`);label.title=breakdown;
        categoryBody.append(el('div',{ class:'row' },label,switchFor(!!settings.buy[key],v=>settings.buy[key]=v,`${title(type,id)} 구매`)));
      }
      content.append(category);
    }
    if (!entries.size) content.append(el('p',{text:'품목 목록을 불러오는 중입니다.'}));
    content.append(el('h3',{text:'구매 결과 알림'}),row('Discord 웹후크',switchFor(settings.webhook.enabled,v=>settings.webhook.enabled=v,'구매 결과 웹후크')),
      el('input',{type:'password',placeholder:'https://discord.com/api/webhooks/…',value:settings.webhook.url,ariaLabel:'웹후크 주소',onchange:e=>{
        try { const value=e.target.value.trim(); if(value) webhookURL(value); settings.webhook.url=value;save();report('웹후크 주소 저장됨'); }
        catch(error){report(error.message);e.target.value=settings.webhook.url;}
      }}));
  }
  let dragEgg='';
  function moveEgg(id,before) {
    if(id===before)return;
    const order=settings.eggs.order.filter(x=>x!==id),index=order.indexOf(before);
    if(index<0)return; order.splice(index,0,id);settings.eggs.order=order;dragEgg='';save();refresh(true);
  }
  function renderPlant() {
    syncEggs();
    content.append(row('알 심기',button('심기',()=>void run('plant',plant),'primary'),'위쪽 알부터 소진 · 심기·부화는 지그재그 순서'),
      row('시작 방향',select(settings.eggs.direction,['좌','우'].map(x=>[x,x]),v=>{settings.eggs.direction=v;refresh();},'밭 시작 방향')));
    let data;try{data=game.data();}catch{}
    for (const [index,id] of settings.eggs.order.entries()) {
      const r=el('div',{class:'row egg-row',draggable:true,ondragstart:e=>{dragEgg=id;e.dataTransfer.setData('text/plain',id);},ondragend:()=>{dragEgg='';},ondragover:e=>e.preventDefault(),ondrop:e=>{e.preventDefault();const from=dragEgg;dragEgg='';if(from)moveEgg(from,id);}},
        el('span',{text:'⠿',class:'grip'}),itemLabel('Egg',id,`${index+1}순위 · 보유 ${data?countEgg(data,id):'—'}개`),
        el('div',{class:'arrows'},button('↑',()=>{if(index>0)moveEgg(id,settings.eggs.order[index-1]);}),button('↓',()=>{if(index<settings.eggs.order.length-1)moveEgg(settings.eggs.order[index+1],id);})),
        switchFor(!!settings.eggs.enabled[id],v=>settings.eggs.enabled[id]=v,`${title('Egg',id)} 심기`));
      content.append(r);
    }
  }
  function renderHatch() {
    content.append(el('p',{text:'현재 부화 가능한 알만 처리합니다. 인벤토리가 가득 차면 중단합니다.'}),button('모두 부화',hatchAll,'primary'));
    let tiles={};try{tiles=garden(game.data());}catch{}
    const ids=[...new Set([...Object.keys(catalog.eggs||{}),...Object.values(tiles).filter(t=>t?.eggId).map(t=>t.eggId)])];
    for (const id of ids) {
      const eggs=Object.values(tiles).filter(t=>t?.eggId===id),ready=eggs.filter(t=>readyEgg(t)).length;
      const b=button('부화',()=>void hatch(id),'pill');b.disabled=ready===0||!!running;
      content.append(el('div',{class:'row'},itemLabel('Egg',id,`부화 가능 ${ready} / 심어진 알 ${eggs.length}`),b));
    }
  }
  function renderSell() {
    content.append(el('p',{text:'인벤토리의 잠금 해제된 펫만 판매합니다. 켜진 보호 조건 중 하나라도 맞으면 제외합니다.'}));
    for(const [key,label] of [['gold','Gold 보호'],['rainbow','Rainbow 보호'],['str','최대 STR 보호']]) content.append(row(label,switchFor(settings.protect[key],v=>{settings.protect[key]=v;refresh();},label)));
    content.append(row('최대 STR 기준',el('input',{type:'number',min:0,max:1000000,step:1,value:settings.protect.threshold,disabled:!settings.protect.str,ariaLabel:'보호할 최대 STR 이상',onchange:e=>{
      const n=Number(e.target.value);if(Number.isInteger(n)&&n>=0&&n<=1000000){settings.protect.threshold=n;save();refresh();}else{e.target.value=settings.protect.threshold;report('STR은 0 이상 정수로 입력하세요.');}
    }}),'입력한 값 이상인 펫을 보호합니다.'));
    let inventory;try{inventory=game.data().inventory;}catch{}
    const pets=(inventory?.items||[]).filter(p=>p?.itemType==='Pet');
    const eligible=pets.filter(p=>!saleReason(p,inventory,settings.protect,catalog));
    content.append(el('div',{class:'summary',text:`인벤토리 ${pets.length}마리 · 판매 대상 ${eligible.length}마리`}),button('펫 판매',()=>void sell(),'primary'),el('small',{text:'판매 대상에 Rainbow가 있으면 실행 전에 한 번 확인합니다.'}));
  }
  function renderFeed() {
    content.append(row('펫 먹이',switchFor(settings.autoFeed,setAutoFeed,'펫 먹이 자동 지급'),'사용 중인 펫 · 배고픔 5% 미만'),
      row('Hunger Potion 전체 허용',switchFor(settings.feed.hungerPotion,v=>{
        settings.feed.hungerPotion=v;observeFeed();refresh(true);
      },'Hunger Potion 전체 허용'),'Off이면 모든 동물에게 포션 지급 제외 · 개별 선택 유지'),
      el('small',{text:'알림 후 1~5초 대기 · 여러 펫은 2초 간격 · 일반 먹이 우선, 허용한 포션만 사용'}),
      el('small',{text:'선택한 먹이만 잠금 해제하고, 남아 있으면 다시 잠급니다.'}));
    const groups=petFoodGroups(catalog);
    if(!groups.length)content.append(el('p',{text:'동물과 먹이 정보를 불러오는 중입니다.'}));
    function folded(key,id,label,className) {
      const details=el('details',{class:className,open:settings.feed[key].includes(id)});
      details.append(el('summary',{},label));
      details.addEventListener('toggle',()=>{
        if(!details.isConnected)return;
        settings.feed[key]=settings.feed[key].filter(v=>v!==id);if(details.open)settings.feed[key].push(id);save();placePanel();
      });
      return details;
    }
    for(const group of groups) {
      const egg=folded('openEggs',group.id,el('span',{text:group.id==='Other'?'기타 동물':title('Egg',group.id)}),'shop-category feed-egg');
      egg.dataset.egg=group.id;
      const body=el('div',{class:'category-body'});egg.append(body);
      for(const {species,probability} of group.pets) {
        const animal=folded('openPets',`${group.id}:${species}`,itemLabel('Pet',species,probability===null?'알 정보 없음':`등장 확률 ${Number(probability.toFixed(2))}%`),'feed-pet');
        animal.dataset.species=species;
        const diet=[...new Set(catalog.pets?.[species]?.diet || [])];
        for(const [type,id] of [...diet.map(id=>['Produce',id]),['Tool','ReplenishPotion']]) {
          const key=foodKey(species,type,id);
          const toggle=switchFor(foodAllowed(settings,species,type,id),v=>{
            settings.feed.allowed[key]=v;observeFeed();
          },`${title('Pet',species)} · ${title(type,id)} 먹이`);
          if(type==='Tool' && id==='ReplenishPotion' && !settings.feed.hungerPotion)toggle.querySelector('input').disabled=true;
          animal.append(el('div',{class:'row'},itemLabel(type,id,''),toggle));
        }
        body.append(animal);
      }
      content.append(egg);
    }
    content.append(el('h3',{text:'Discord 웹후크'}),row('먹이 알림',switchFor(settings.feed.webhook.enabled,v=>settings.feed.webhook.enabled=v,'펫 먹이 웹후크'),'배고픔·급식 완료·급식 중단 알림'),
      el('input',{type:'password',placeholder:'https://discord.com/api/webhooks/…',value:settings.feed.webhook.url,ariaLabel:'펫 먹이 웹후크 주소',onchange:e=>{
        try{const value=e.target.value.trim();if(value)webhookURL(value);settings.feed.webhook.url=value;save();report('펫 먹이 웹후크 주소 저장됨');}
        catch(error){report(error.message);e.target.value=settings.feed.webhook.url;}
      }}));
  }
  function teamSnapshot() {
    if(game.socket && game.socket.readyState!==1)return null;
    const native=nativeGameTeams.read(game.selfId,game.root);
    const wire=nativeTeams(mySlot(game.root,game.selfId)?.data),accountId=accountKey(game.root,game.selfId);
    const registered=settings.registeredTeams.filter(t=>accountId && t.accountId===accountId).map(t=>({...t,manual:true}));
    if(native===null && wire===null && !registered.length)return null;
    // An empty/unavailable reader must not hide another source's confirmed teams.
    const merged=new Map(registered.map(t=>[t.id,t]));
    for(const t of [...(wire || []),...(native || [])])merged.set(t.id,t);
    return [...merged.values()];
  }
  async function refreshNativeTeams() {
    await nativeGameTeams.connect();
    if(view==='settings')report(syncTeamControls());
  }
  function teamOptions(key,teams) {
    const options=(teams || []).map(t=>[t.id,`${t.manual?'직접 등록 · ':''}${typeof t.name==='string' && t.name.trim()?t.name:t.id}`]);
    const opts=key==='restore'?[['current','현재 프리셋'],...options]:[['','변경 안 함'],...options];
    if(settings.teams[key]&&!opts.some(([id])=>id===settings.teams[key]))opts.push([settings.teams[key],teams===null?'팀 목록 확인 대기':'선택한 팀 확인 필요']);
    return opts;
  }
  function syncTeamControls() {
    const teams=teamSnapshot();
    for(const node of content.querySelectorAll('select[data-preset]')) {
      const key=node.dataset.preset,opts=teamOptions(key,teams),signature=JSON.stringify(opts);
      if(node.dataset.options!==signature) {
        node.replaceChildren(...opts.map(([value,text])=>el('option',{value,text})));
        node.dataset.options=signature;node.value=settings.teams[key];
      }
    }
    const missing=teams!==null && Object.entries(settings.teams).some(([key,id])=>id && !(key==='restore' && id==='current') && !teams.some(t=>t.id===id));
    const manualCount=teams?.filter(t=>t.manual).length || 0,nativeCount=(teams?.length || 0)-manualCount;
    const text=teams===null?'게임 펫 팀 동기화 대기':`게임 펫 팀 ${nativeCount}개${manualCount?` · 직접 등록 ${manualCount}개`:''}${missing?' · 찾을 수 없는 선택이 있습니다. 팀을 다시 선택하세요.':nativeCount?' · 새 팀과 이름 변경 자동 반영':manualCount?' · 등록한 프리셋 사용 가능':' · 목록이 비어 있으면 아래에서 직접 등록하세요.'}`;
    const label=content.querySelector('.team-status');if(label)label.textContent=text;
    const current=content.querySelector('.manual-team-current');
    if(current)current.textContent=`감지된 현재 프리셋: ${currentTeam()?.id || '게임에서 사용할 펫 팀을 한 번 적용하세요.'}`;
    return text;
  }
  function currentTeam() {
    if(game.nativeTeamAttempt && Date.now()-game.nativeTeamAttempt.at<=10000)return null;
    let data;try{data=game.data();}catch{return null;}
    const ids=activeIds(data),accountId=accountKey(game.root,game.selfId);
    if(!ids.length)return null;
    const observed=game.lastNativeTeam;
    if(observed && observed.generation===game.generation && observed.accountId===accountId && sameIds(members(observed),ids))return observed;
    return teamSnapshot()?.find(t=>sameIds(members(t),ids)) || null;
  }
  function registerCurrentTeam(key,explicitId='') {
    if(running)throw Error('진행 중인 작업이 끝난 뒤 프리셋을 등록하세요.');
    if(game.nativeTeamAttempt && Date.now()-game.nativeTeamAttempt.at<=10000)throw Error('게임 펫 팀 변경 확인 중 · 적용이 끝난 뒤 등록하세요.');
    const data=game.data(),accountId=accountKey(game.root,game.selfId),ids=activeIds(data);
    const detected=currentTeam(),id=explicitId.trim() || detected?.id;
    if(!id)throw Error('게임에서 원하는 펫 팀을 한 번 적용한 뒤 현재 프리셋을 누르세요.');
    if(!/^[\w:.-]{1,160}$/.test(id))throw Error('프리셋 ID 형식을 확인하세요.');
    if(!accountId)throw Error('내 계정 정보 확인 대기 · 프리셋 등록 보류');
    if(ids.length<1 || ids.length>3 || new Set(ids).size!==ids.length)throw Error('사용 중인 펫 1~3마리를 확인한 뒤 등록하세요.');
    const names={hatch:'부화',sell:'판매',restore:'복구'};
    const previous=settings.registeredTeams.find(t=>t.id===id && t.accountId===accountId);
    if(!previous && settings.registeredTeams.length>=60)throw Error('직접 등록 프리셋은 최대 60개입니다.');
    const record={id,accountId,name:previous?.name || (detected?.id===id && detected.name) || `${names[key]} 프리셋`,members:ids.map(petId=>({petId}))};
    settings.registeredTeams=settings.registeredTeams.filter(t=>!(t.id===id && t.accountId===accountId));
    settings.registeredTeams.push(record);settings.teams[key]=id;save();refresh(true);
    report(`${names[key]} 현재 프리셋 등록 완료 · 펫 ${ids.length}마리`);
  }
  function renderManualTeams() {
    const details=el('details',{class:'shop-category manual-teams',open:settings.manualTeamsOpen});
    details.append(el('summary',{text:'현재 프리셋 직접 등록'}));
    details.addEventListener('toggle',()=>{if(details.isConnected){settings.manualTeamsOpen=details.open;save();placePanel();}});
    const body=el('div',{class:'category-body'});
    body.append(el('small',{text:'게임에서 원하는 펫 팀을 한 번 적용한 뒤, 해당 용도의 현재 프리셋 버튼을 누르세요. 팀 목록 없이도 등록할 수 있습니다.'}));
    for(const [key,label] of [['hatch','부화'],['sell','판매'],['restore','복구']]) {
      const input=el('input',{type:'text',ariaLabel:`${label} 프리셋 ID 직접 입력`,placeholder:'현재 팀 ID 또는 직접 입력',value:settings.teams[key]==='current'?'':settings.teams[key],maxLength:160});
      const apply=button('현재 프리셋',()=>{try{registerCurrentTeam(key);}catch(error){report(error.message);}});
      apply.setAttribute('aria-label',`${label} 현재 프리셋 등록`);
      input.addEventListener('change',()=>{
        try{if(input.value.trim())registerCurrentTeam(key,input.value);else{settings.teams[key]=key==='restore'?'current':'';save();syncTeamControls();}}
        catch(error){report(error.message);input.value=settings.teams[key]==='current'?'':settings.teams[key];}
      });
      body.append(el('div',{class:'row'},el('span',{text:label}),el('div',{class:'manual-team-input'},input,apply)));
    }
    body.append(el('small',{class:'manual-team-current'}),el('small',{text:'직접 입력할 ID는 현재 착용 중인 게임 팀의 ID여야 합니다. 등록 내용은 설정 파일에 함께 저장됩니다.'}));
    details.append(body);return details;
  }
  function renderSettings() {
    const teams=teamSnapshot();
    for (const [key,name] of [['hatch','부화 프리셋'],['sell','판매 프리셋'],['restore','종료 후 복구']]) {
      const opts=teamOptions(key,teams),node=select(settings.teams[key],opts,v=>{settings.teams[key]=v;syncTeamControls();},name);
      node.dataset.preset=key;node.dataset.options=JSON.stringify(opts);content.append(row(name,node));
    }
    content.append(el('small',{class:'team-status'}),button('팀 목록 새로고침',()=>void refreshNativeTeams()));
    content.append(renderManualTeams());
    syncTeamControls();
    content.append(el('small',{text:'현재 프리셋은 실행 직전의 게임 펫 팀입니다. 복구도 게임 팀 변경 기능을 사용합니다.'}),el('h3',{text:'설정 백업'}));
    content.append(button('모든 설정 파일로 저장',exportSettings,'primary'),el('small',{text:'웹후크 주소, On/Off 상태와 아이콘 위치도 파일에 포함됩니다.'}));
    const input=el('input',{type:'file',accept:'.json,application/json',hidden:true,onchange:async e=>{
      const picker=e.currentTarget,file=picker.files?.[0];if(!file)return;
      try{if(file.size>1024*1024)throw Error('설정 파일은 1MB 이하여야 합니다.');importSettings(await file.text());}catch(error){report(error.message);}picker.value='';
    }});
    const url=el('input',{type:'url',placeholder:'설정 JSON 직접 다운로드 링크',ariaLabel:'설정 링크'});
    content.append(button('설정 파일 불러오기',()=>input.click()),input,el('h3',{text:'링크에서 불러오기'}),url,
      button('링크 불러오기',async()=>{
        try {
          if(running)throw Error('진행 중인 작업이 끝난 뒤 설정을 불러오세요.');
          const link=new URL(url.value.trim());if(link.protocol!=='https:'||link.username||link.password)throw Error('HTTPS 설정 파일 주소를 입력하세요.');
          report('설정 링크 불러오는 중…');
          const res=await request(link.href);if(res.status!==200)throw Error(`설정 다운로드 실패 (${res.status})`);
          importSettings(res.responseText);
        }catch(error){report(error.message);}
      }),el('small',{text:'로그인 없이 JSON을 직접 내려주는 링크를 사용하세요.'}),el('h3',{text:'최근 상태'}),el('pre',{text:log.slice(0,12).join('\n')||'아직 기록이 없습니다.'}),el('small',{text:`Snail in Cherry ${VERSION} · 0_"`}));
  }
  function exportSettings() {
    const text=JSON.stringify({format:'Snail in Cherry',version:1,scriptVersion:VERSION,settings},null,2);
    const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
    const a=el('a',{href:url,download:`Snail-in-Cherry-settings-${new Date().toISOString().slice(0,10)}.json`});
    shadow.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);report('설정 파일 저장 완료');
  }
  function importSettings(text) {
    if(running)throw Error('진행 중인 작업이 끝난 뒤 설정을 불러오세요.');
    const next=parseSettings(text),wasBuy=settings.autoBuy;settings=next;clearFeeding();save();syncEggs();placeIcon();refresh(true);report('모든 설정을 불러왔습니다.');
    if(!settings.autoBuy)pendingBuy.clear();
    if(settings.autoBuy&&!wasBuy){void loadCatalog();void loadLive();scheduleBuy();}
    if(settings.autoFeed)void loadCatalog().then(observeFeed);
  }
  function askRainbow(pets) {
    panel.hidden=false;
    return new Promise(resolve=>{
      const overlay=el('div',{class:'overlay',role:'dialog',ariaLabel:'Rainbow 펫 판매 확인'});
      const end=value=>{overlay.remove();resolve(value);};
      const yes=button('판매 진행',()=>end(true),'primary');
      const no=button('취소',()=>end(false));
      overlay.append(el('div',{class:'dialog'},el('h2',{text:'Rainbow 펫이 포함되어 있어요'}),el('p',{text:`이번 판매에 Rainbow ${pets.length}마리가 포함됩니다.`}),
        el('ul',{},pets.map(p=>el('li',{text:p.name||title('Pet',p.petSpecies)}))),el('div',{class:'actions'},no,yes)));
      overlay.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();end(false);}if(e.key==='Tab'){e.preventDefault();(shadow.activeElement===no?yes:no).focus();}});
      shadow.append(overlay);no.focus();
    });
  }
  function placeIcon() {
    if(!icon)return;
    const p=settings.position||{left:innerWidth-60,top:innerHeight*.35};
    icon.style.left=`${Math.max(8,Math.min(innerWidth-52,p.left))}px`;
    icon.style.top=`${Math.max(8,Math.min(innerHeight-52,p.top))}px`;
  }
  function placePanel() {
    if(!panel || panel.hidden)return;
    const rect=panel.getBoundingClientRect();
    const p=settings.panelPosition || {left:innerWidth-rect.width-(innerWidth<520?12:76),top:Math.min(68,innerHeight*.08)};
    panel.style.right='auto';
    panel.style.left=`${Math.max(8,Math.min(innerWidth-rect.width-8,p.left))}px`;
    panel.style.top=`${Math.max(8,Math.min(innerHeight-rect.height-8,p.top))}px`;
  }
  function enablePanelDrag(handle) {
    let drag=null;
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0 || event.target.closest('button,input,select'))return;
      const rect=panel.getBoundingClientRect();
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,moved:false};
      handle.setPointerCapture(event.pointerId);event.preventDefault();
    });
    handle.addEventListener('pointermove',event=>{
      if(!drag || drag.id!==event.pointerId)return;
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if(!drag.moved && Math.hypot(dx,dy)<4)return;
      drag.moved=true;settings.panelPosition={left:drag.left+dx,top:drag.top+dy};placePanel();
    });
    const finish=event=>{
      if(!drag || drag.id!==event.pointerId)return;
      if(drag.moved){const rect=panel.getBoundingClientRect();settings.panelPosition={left:rect.left,top:rect.top};save();}
      drag=null;if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
    };
    for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,finish);
  }
  function mount() {
    const host=el('div',{id:'snail-in-cherry'});document.documentElement.append(host);shadow=host.attachShadow({mode:'open'});
    const style=el('style',{text:`
      :host{all:initial;color-scheme:dark;font:12px/1.45 system-ui,-apple-system,"Malgun Gothic",sans-serif;color:#e5e8e9}
      *{box-sizing:border-box}[hidden]{display:none!important}button,input,select{font:inherit;color:inherit}button{cursor:pointer;border:1px solid #ffffff24;background:#ffffff07;border-radius:5px;padding:5px 8px;transition:background .12s}button:hover{background:#ffffff13;border-color:#ffffff40}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #6caf84;outline-offset:2px}
      .icon{position:fixed;width:44px;height:44px;padding:0;border-radius:50%;background:#293229ed;color:#fff;font-size:24px;box-shadow:0 5px 18px #0005;z-index:2147483644;touch-action:none;user-select:none;cursor:grab}
      .panel{position:fixed;right:76px;top:68px;width:340px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);display:flex;flex-direction:column;background:linear-gradient(135deg,#242821f5,#22262ef5);backdrop-filter:blur(16px);border:1px solid #ffffff1c;border-radius:8px;box-shadow:0 14px 40px #0005;z-index:2147483645;overflow:hidden}.panel.home{width:224px}
      header{padding:9px 10px 0;flex:none;cursor:move;touch-action:none;user-select:none}.brand{display:flex;align-items:center;justify-content:space-between;gap:8px}.brand strong{font-size:13px;font-weight:650;flex:1;padding:5px 0;letter-spacing:-.2px}.brand button{font-size:17px;line-height:1;width:25px;height:25px;padding:0;color:#c7cccd;cursor:pointer}.badges{display:flex;align-items:center;gap:7px;margin:6px 0 8px}.badges span{font-size:11px;border:1px solid #4b8562;background:#32544044;border-radius:5px;padding:2px 6px;color:#e0eee5}.subhead{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid #ffffff16;cursor:default}.page-name{flex:1;font-size:12px;color:#aeb8b4}.home .subhead{padding:0;border-top:0}.home .page-name{display:none}.back{font-size:11px;padding:4px 8px}.stop{font-size:11px;color:#f0c8c2;border-color:#8c635f;margin:6px 10px;align-self:flex-end;flex:none}
      .body{padding:0 10px 9px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#ffffff28 transparent;min-height:0}.home .body{padding:4px 10px 8px;border-top:1px solid #ffffff16}.menu-row{display:flex;align-items:center;min-height:34px;gap:8px}.menu-link{flex:1;text-align:left;background:none;border:0;font-weight:500;padding:6px 0;border-radius:4px}.menu-link:hover{background:#ffffff06}.pill{font-size:12px;min-width:43px;padding:4px 7px;border:1px solid #ffffff25;background:#ffffff06}
      .row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #ffffff0d}.grow{flex:1;min-width:0}.label{font-weight:500;overflow-wrap:anywhere}small{display:block;font-size:11px;color:#97a39f;line-height:1.4;margin-top:2px}p{font-size:12px;color:#b1bab7;margin:7px 0 9px}h3{font-size:12px;color:#b7c9bf;margin:12px 0 4px;font-weight:600}h2{font-size:17px;margin-top:0}
      .manual-team-input{display:flex;gap:4px;flex:1;min-width:0}.manual-team-input input{width:0;flex:1}.manual-team-input button{flex:none;font-size:10px;padding:4px 5px}.manual-team-current{overflow-wrap:anywhere;padding:5px 0}.manual-teams .category-body>small{padding-top:5px}
      .rooms{display:flex;gap:6px;padding-top:8px;margin-top:5px;border-top:1px solid #ffffff16}.rooms a{flex:1;text-align:center;color:#dce6df;text-decoration:none;padding:5px 0;border:1px solid #ffffff24;border-radius:4px;background:#ffffff07}.rooms a:hover{background:#ffffff13}
      .menu-pages{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid #ffffff16;margin-top:8px;padding-top:8px}.menu-pages button{padding:3px 13px}.menu-pages span{font-size:11px;color:#a7b7ad}.menu-pages button:disabled{opacity:.35;cursor:default}
      .feed-pet{border-top:1px solid #ffffff14}.feed-pet>summary{padding:7px 0;background:none}.feed-pet>summary .item{min-width:0}.feed-pet>.row{padding:5px 0 5px 10px}.feed-pet>.row small:empty{display:none}
      .switch{display:inline-flex;flex:none;position:relative;width:35px;height:21px;cursor:pointer}.switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}.switch span{width:35px;height:21px;border-radius:12px;background:#ffffff24;pointer-events:none}.switch span:after{content:'';display:block;width:15px;height:15px;border-radius:50%;background:#d7dedb;margin:3px;transition:transform .15s}.switch input:checked+span{background:#498060}.switch input:checked+span:after{transform:translateX(14px);background:#f1fff6}.switch input:focus-visible+span{outline:2px solid #6caf84;outline-offset:3px}
      select,input:not([type=checkbox]){background:#161d1acc;border:1px solid #ffffff26;border-radius:4px;padding:5px;max-width:100%;min-width:0}select option{background:#252e29;color:#e5e8e9}.row select{max-width:175px}.row input[type=number]{width:84px}.body>input{width:100%;margin:8px 0}.body>button{margin:6px 5px 3px 0}.primary{background:#3e664b;border-color:#6a9876;color:#f2fff6}.primary:hover{background:#4a775a}.item{display:flex;align-items:center;gap:9px;flex:1;min-width:0}.item img,.fallback{width:25px;height:25px;object-fit:contain;image-rendering:pixelated;flex:none}.fallback{text-align:center;line-height:25px}.grip{color:#88998f;cursor:grab;user-select:none}.arrows{display:flex;flex-direction:column;gap:2px}.arrows button{font-size:10px;padding:0 5px;border-radius:4px}
      .shop-category{margin-top:7px;border:1px solid #ffffff1b;border-radius:5px;overflow:hidden}.shop-category summary{cursor:pointer;display:flex;align-items:center;gap:7px;padding:7px 8px;background:#ffffff05;list-style:none;font-weight:600;user-select:none}.shop-category summary::-webkit-details-marker{display:none}.shop-category summary:before{content:'›';font-size:17px;line-height:1;color:#9eaea4;transition:transform .12s}.shop-category[open]>summary:before,.feed-pet[open]>summary:before{transform:rotate(90deg)}.shop-category summary small{margin:0 0 0 auto;font-size:10px;font-weight:400}.category-body{padding:0 8px}.category-body .row:last-child{border-bottom:0}
      .summary{padding:8px;background:#ffffff08;border:1px solid #ffffff13;border-radius:5px;margin:8px 0}footer{padding:6px 10px;border-top:1px solid #ffffff16;font-size:10px;color:#a7b7ad;background:#00000012;overflow-wrap:anywhere;flex:none;max-height:75px;overflow:auto}pre{white-space:pre-wrap;font-size:10px;line-height:1.8;color:#99aaa0;max-height:160px;overflow:auto}.overlay{position:fixed;inset:0;background:#10171299;display:grid;place-items:center;z-index:2147483646}.dialog{background:#262e28;border:1px solid #ffffff24;border-radius:8px;padding:15px;width:370px;max-width:calc(100vw - 24px);box-shadow:0 20px 80px #0007}.dialog ul{max-height:200px;overflow:auto;padding-left:20px}.actions{display:flex;justify-content:flex-end;gap:8px}@media(max-width:520px){.panel{max-height:calc(100dvh - 16px)}.body{padding:0 10px 9px}.row select{max-width:170px}}
    `});
    icon=button('🐌',()=>{panel.hidden=!panel.hidden;if(!panel.hidden)refresh();},'icon');icon.setAttribute('aria-label','Snail in Cherry 열기');
    icon.onclick=null;
    // Pointer drag and click are separated with the Floating Bell's 4px threshold.
    let drag=null,suppressClick=false;
    icon.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();suppressClick=false;}},true);
    icon.addEventListener('pointerdown',e=>{if(e.button!==0)return;const rect=icon.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:rect.left,top:rect.top,moved:false};icon.setPointerCapture(e.pointerId);});
    icon.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<4)return;drag.moved=true;settings.position={left:drag.left+dx,top:drag.top+dy};placeIcon();});
    const endDrag=e=>{if(!drag)return;suppressClick=drag.moved;if(drag.moved){const r=icon.getBoundingClientRect();settings.position={left:r.left,top:r.top};save();}drag=null;if(icon.hasPointerCapture(e.pointerId))icon.releasePointerCapture(e.pointerId);};
    icon.addEventListener('pointerup',endDrag);icon.addEventListener('pointercancel',endDrag);
    content=el('main',{class:'body'});footer=el('footer',{role:'status','ariaLive':'polite',text:status});
    panel=el('section',{class:'panel',hidden:true,ariaLabel:'Snail in Cherry'},el('header',{},
      el('div',{class:'brand'},el('strong',{text:'Snail in Cherry',class:'title-handle',title:'드래그하여 창 이동'}),button('×',()=>panel.hidden=true)),
      el('div',{class:'badges'},el('span',{class:'connection',text:'○ 연결 대기'}),el('span',{class:'version',text:VERSION})),
      el('div',{class:'subhead'},button('‹ 뒤로',()=>go('home'),'back'),el('span',{class:'page-name'}))),content,footer,
      button('중지',()=>{if(running){running.cancel=true;if(running.kind==='feed')setAutoFeed(false);if(running.kind==='buy')setAutoBuy(false);save();}report('현재 요청 확인 후 중지합니다.');},'stop'));
    enablePanelDrag(panel.querySelector('header'));
    shadow.append(style,icon,panel);placeIcon();window.addEventListener('resize',()=>{placeIcon();placePanel();});refresh();void loadCatalog();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();

// BEGIN embedded Snail with Skins
if (typeof window !== "undefined" && !(typeof module === "object" && module.exports)) {
// Sprite discovery and atlas decoding adapted from the supplied Arie's Mod 4.0.3.
// Standalone visual controls; does not send game commands or edit game data.
(function () {
'use strict';
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
  // src/platform/pageContext.ts
  function shareGlobal(name, value) {
    try {
      pageWindow[name] = value;
    } catch {
    }
    if (isSandboxed) {
      try {
        sandboxWindow[name] = value;
      } catch {
      }
    }
  }
  function readSharedGlobal(name) {
    if (isSandboxed) {
      const sandboxValue = sandboxWindow[name];
      if (sandboxValue !== void 0) return sandboxValue;
    }
    return pageWindow[name];
  }
  var sandboxWindow, pageWindow, isSandboxed;
  var init_pageContext = __esm({
    "src/platform/pageContext.ts"() {
      "use strict";
      sandboxWindow = window;
      pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : sandboxWindow;
      isSandboxed = pageWindow !== sandboxWindow;
    }
  });

  // src/game/sprites/settings.ts
  var DEFAULT_CFG, MUT_G1, MUT_G2, MUT_G3;
  var init_settings = __esm({
    "src/game/sprites/settings.ts"() {
      "use strict";
      DEFAULT_CFG = {
        origin: "https://magicgarden.gg"
      };
      MUT_G1 = ["", "Gold", "Rainbow"].filter(Boolean);
      MUT_G2 = ["", "Wet", "Chilled", "Frozen", "Thunderstruck", "Thundercharged"].filter(Boolean);
      MUT_G3 = ["", "Dawnlit", "Ambershine", "Dawncharged", "Ambercharged"].filter(Boolean);
    }
  });

  // src/game/sprites/state.ts
  function createInitialState() {
    return {
      started: false,
      loaded: false,
      version: null,
      base: null,
      ctors: null,
      app: null,
      renderer: null,
      tex: /* @__PURE__ */ new Map(),
      atlasBases: /* @__PURE__ */ new Set()
    };
  }
  function createSpriteContext() {
    return {
      cfg: { ...DEFAULT_CFG },
      state: createInitialState()
    };
  }
  var init_state = __esm({
    "src/game/sprites/state.ts"() {
      "use strict";
      init_settings();
    }
  });

  // src/game/sprites/context.ts
  function setPixiHooks(hooks2) {
    pixiHooks = hooks2;
  }
  function getSpriteState() {
    return spriteContext.state;
  }
  function getReadySpriteState() {
    const state5 = spriteContext.state;
    return state5.renderer && state5.ctors?.Text ? state5 : null;
  }
  function getPixiApp() {
    return pixiHooks?.app ?? spriteContext.state.app;
  }
  var spriteContext, pixiHooks;
  var init_context = __esm({
    "src/game/sprites/context.ts"() {
      "use strict";
      init_state();
      spriteContext = createSpriteContext();
      pixiHooks = null;
    }
  });

  // src/game/sprites/utils/async.ts
  async function waitWithTimeout(p, ms, label2) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const result = await Promise.race([p, sleep(50).then(() => null)]);
      if (result !== null) return result;
    }
    throw new Error(`${label2} timeout`);
  }
  var sleep;
  var init_async = __esm({
    "src/game/sprites/utils/async.ts"() {
      "use strict";
      init_pageContext();
      sleep = (ms) => new Promise((resolve) => pageWindow.setTimeout(resolve, ms));
    }
  });

  // src/game/sprites/pixi/hooks.ts
  function mkSyntheticApp(renderer) {
    const stage = renderer?.lastObjectRendered ?? renderer?.stage ?? null;
    return { renderer, stage };
  }
  function createPixiHooks() {
    let appResolver;
    let rdrResolver;
    const appReady = new Promise((resolve) => appResolver = resolve);
    const rendererReady = new Promise((resolve) => rdrResolver = resolve);
    let APP = null;
    let RDR = null;
    let PIXI_VER = null;
    const resolveApp = (a) => {
      APP = a;
      appResolver(a);
    };
    const resolveRdr = (r, v) => {
      RDR = r;
      if (v) PIXI_VER = v;
      rdrResolver(r);
      resolveApp(APP ?? mkSyntheticApp(r));
    };
    const hook = (name, cb) => {
      const root4 = pageWindow;
      const prev = root4[name];
      root4[name] = function() {
        try {
          cb.apply(this, arguments);
        } finally {
          if (typeof prev === "function") {
            try {
              prev.apply(this, arguments);
            } catch {
            }
          }
        }
      };
    };
    hook("__PIXI_APP_INIT__", (a, v) => {
      if (v) PIXI_VER = v;
      resolveApp(a);
    });
    hook("__PIXI_RENDERER_INIT__", (r, v) => resolveRdr(r, v));
    const tryResolveExisting = () => {
      const root4 = pageWindow;
      const devtools = root4.__PIXI_DEVTOOLS__;
      if (devtools?.renderers?.size > 0) {
        const rdr = [...devtools.renderers][0];
        if (rdr) resolveRdr(rdr);
      }
      if (!APP) {
        const maybeApp = root4.__PIXI_APP__ || root4.PIXI_APP || root4.app;
        if (maybeApp?.renderer) resolveApp(maybeApp);
      }
      if (!RDR) {
        const maybeRdr = root4.__PIXI_RENDERER__ || root4.renderer || APP?.renderer;
        if (maybeRdr) resolveRdr(maybeRdr);
      }
    };
    tryResolveExisting();
    const pageWin = pageWindow;
    let fallbackPolls = 0;
    const fallbackInterval = pageWin.setInterval(() => {
      if (APP && RDR) {
        pageWin.clearInterval(fallbackInterval);
        return;
      }
      tryResolveExisting();
      fallbackPolls += 1;
      if (fallbackPolls >= 50) {
        pageWin.clearInterval(fallbackInterval);
      }
    }, 100);
    return {
      get app() {
        return APP;
      },
      get renderer() {
        return RDR;
      },
      get pixiVersion() {
        return PIXI_VER;
      },
      appReady,
      rendererReady
    };
  }
  async function waitForPixi(handles, timeoutMs = 15e3) {
    const app = await waitWithTimeout(handles.appReady, timeoutMs, "PIXI app");
    const renderer = await waitWithTimeout(handles.rendererReady, timeoutMs, "PIXI renderer");
    return { app, renderer, version: handles.pixiVersion };
  }
  var init_hooks = __esm({
    "src/game/sprites/pixi/hooks.ts"() {
      "use strict";
      init_async();
      init_pageContext();
    }
  });

  // src/game/sprites/utils/pixi.ts
  function findAny(root4, pred, lim = 25e3) {
    const stack = [root4];
    const seen = /* @__PURE__ */ new Set();
    let n = 0;
    while (stack.length && n++ < lim) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (pred(node)) return node;
      const children = node.children;
      if (Array.isArray(children)) {
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
      }
    }
    return null;
  }
  function findAnyPerBranch(root4, pred, limPerBranch = 25e3) {
    if (!root4) return null;
    if (pred(root4)) return root4;
    const children = root4.children;
    if (!Array.isArray(children)) return null;
    for (const child of children) {
      const hit = findAny(child, pred, limPerBranch);
      if (hit) return hit;
    }
    return null;
  }
  function ctorsFromStage(stage) {
    if (!stage) return null;
    const anySpr = findAnyPerBranch(stage, (x) => x?.texture?.frame && x?.constructor && x?.texture?.constructor && x?.texture?.frame?.constructor);
    if (!anySpr) return null;
    const hasTextAndStyle = (x) => (typeof x?.text === "string" || typeof x?.text === "number") && x?.style;
    const isRiveLikeNode = (x) => !!(x?.artboard || x?.stateMachine || x?.rive);
    const anyTxt = findAnyPerBranch(stage, (x) => hasTextAndStyle(x) && x?.renderPipeId === "text") ?? findAnyPerBranch(stage, (x) => hasTextAndStyle(x) && !isRiveLikeNode(x));
    // Skins do not require a text node.
    return {
      Container: stage.constructor,
      Sprite: anySpr.constructor,
      Texture: anySpr.texture.constructor,
      Rectangle: anySpr.texture.frame.constructor,
      Text: anyTxt?.constructor ?? null
    };
  }
  function getCtors(app) {
    const root4 = pageWindow;
    const P = root4.PIXI;
    if (P?.Texture && P?.Sprite && P?.Container && P?.Rectangle) {
      return { Container: P.Container, Sprite: P.Sprite, Texture: P.Texture, Rectangle: P.Rectangle, Text: P.Text || null };
    }
    const renderer = app?.renderer ?? app;
    for (const candidate of [app?.stage, renderer?.lastObjectRendered, renderer?.stage]) {
      const hit = ctorsFromStage(candidate);
      if (hit) return hit;
    }
    throw new Error("No Sprite found (ctors): PIXI not exposed and stage not yet rendered.");
  }
  function rememberBaseTex(tex, atlasBases) {
    const base = baseTexOf(tex);
    if (base) atlasBases.add(base);
  }
  var baseTexOf;
  var init_pixi = __esm({
    "src/game/sprites/utils/pixi.ts"() {
      "use strict";
      init_pageContext();
      baseTexOf = (tex) => tex?.baseTexture ?? tex?.source?.baseTexture ?? tex?.source ?? tex?._baseTexture ?? null;
    }
  });

  // src/game/sprites/pixi/resolvePixi.ts
  async function resolvePixiFast(hooks2) {
    const root4 = pageWindow;
    const debugInfo = {
      startedAt: Date.now(),
      resolvedVia: null,
      resolvedAt: null
    };
    root4.__SNAIL_SKINS_RESOLVE_PIXI_DEBUG__ = debugInfo;
    const resolved = (via, bundle) => {
      debugInfo.resolvedVia = via;
      debugInfo.resolvedAt = Date.now();
      return bundle;
    };
    const check = () => {
      const app = root4.__PIXI_APP__ || root4.PIXI_APP || root4.app || null;
      const renderer = root4.__PIXI_RENDERER__ || root4.PIXI_RENDERER__ || root4.renderer || app?.renderer || null;
      return app && renderer ? { app, renderer, version: root4.__PIXI_VERSION__ || null } : null;
    };
    const hit = check();
    if (hit) return resolved("fast-check-immediate", hit);
    const start2 = performance.now();
    while (performance.now() - start2 < 5e3) {
      await sleep(50);
      const retry = check();
      if (retry) return resolved("fast-check-retry", retry);
    }
    const waited = await waitForPixi(hooks2);
    return resolved("waitForPixi-fallback", { app: waited.app, renderer: waited.renderer, version: waited.version });
  }
  function inspectStage(root4) {
    const stack = [root4];
    const seen = /* @__PURE__ */ new Set();
    let totalNodes = 0;
    let spriteLikeCount = 0;
    let textLikeCount = 0;
    let n = 0;
    while (stack.length && n++ < 25e3) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      totalNodes++;
      if (cur?.texture?.frame && cur?.constructor && cur?.texture?.constructor && cur?.texture?.frame?.constructor) spriteLikeCount++;
      if ((typeof cur?.text === "string" || typeof cur?.text === "number") && cur?.style) textLikeCount++;
      const children = cur.children;
      if (Array.isArray(children)) {
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
      }
    }
    const topChildLabels = Array.isArray(root4?.children) ? root4.children.map((c) => c?.label || c?.constructor?.name || typeof c) : [];
    return { totalNodes, spriteLikeCount, textLikeCount, topChildLabels };
  }
  async function waitForCtors(app, renderer) {
    const attempts = [];
    pageWindow.__SNAIL_SKINS_CTORS_DEBUG__ = attempts;
    let iteration = 0;
    const snapshot3 = () => {
      const stage = app?.stage;
      const lor = renderer?.lastObjectRendered;
      const rStage = renderer?.stage;
      const walkRoot = stage || lor || rStage || null;
      attempts.push({
        at: Date.now(),
        hasAppStage: !!stage,
        appStageChildren: Array.isArray(stage?.children) ? stage.children.length : -1,
        hasLastObjectRendered: !!lor,
        lastObjectRenderedChildren: Array.isArray(lor?.children) ? lor.children.length : -1,
        hasRendererStage: !!rStage,
        rendererStageChildren: Array.isArray(rStage?.children) ? rStage.children.length : -1,
        documentHidden: typeof document !== "undefined" ? document.hidden : false,
        visibilityState: typeof document !== "undefined" ? document.visibilityState : "unknown",
        hasFocus: typeof document !== "undefined" ? document.hasFocus() : false,
        // The deep walk is costly: about once a second, not every 100 ms.
        inspect: walkRoot && iteration % 10 === 0 ? inspectStage(walkRoot) : null
      });
      iteration += 1;
    };
    const deadline = Date.now() + 1e4;
    while (Date.now() < deadline) {
      snapshot3();
      try {
        return getCtors(app);
      } catch {
      }
      if (app && !app.stage && renderer?.lastObjectRendered) {
        app.stage = renderer.lastObjectRendered;
      }
      await sleep(100);
    }
    snapshot3();
    return getCtors(app);
  }
  var init_resolvePixi = __esm({
    "src/game/sprites/pixi/resolvePixi.ts"() {
      "use strict";
      init_pageContext();
      init_hooks();
      init_pixi();
      init_async();
    }
  });

  // src/game/sprites/pixi/rendererHealth.ts
  function canvasOf(renderer) {
    return renderer?.canvas || renderer?.view?.canvas || renderer?.view || null;
  }
  function watchRendererHealth(state5, hooks2) {
    const pageWin = pageWindow;
    let staleStreak = 0;
    let needsCtorsRederive = false;
    const debugState3 = {
      checks: 0,
      staleStreak: 0,
      swaps: [],
      ctorsRederiveAttempts: 0,
      lastCtorsRederiveError: null
    };
    pageWin.__SNAIL_SKINS_RENDERER_HEALTH_DEBUG__ = debugState3;
    pageWin.setInterval(() => {
      try {
        debugState3.checks += 1;
        if (needsCtorsRederive) {
          debugState3.ctorsRederiveAttempts += 1;
          try {
            state5.ctors = getCtors(state5.app ?? state5.renderer);
            needsCtorsRederive = false;
            debugState3.lastCtorsRederiveError = null;
            console.info("[Snail with Skins] re-derived ctors from the new renderer");
          } catch (error) {
            debugState3.lastCtorsRederiveError = String(error?.message ?? error);
          }
        }
        const canvas = canvasOf(state5.renderer);
        const canvasHealthy = !!canvas && typeof document !== "undefined" && document.contains(canvas);
        if (canvasHealthy) {
          staleStreak = 0;
          debugState3.staleStreak = 0;
          return;
        }
        staleStreak += 1;
        debugState3.staleStreak = staleStreak;
        if (staleStreak < REQUIRED_STALE_STREAK) return;
        const freshRenderer = hooks2.renderer;
        if (!freshRenderer || freshRenderer === state5.renderer) return;
        const freshCanvas = canvasOf(freshRenderer);
        if (!freshCanvas || typeof document === "undefined" || !document.contains(freshCanvas)) return;
        console.info("[Snail with Skins] renderer canvas went stale, re-resolved a fresh one");
        debugState3.swaps.push({ at: Date.now(), fromCanvasInDoc: canvasHealthy });
        state5.renderer = freshRenderer;
        if (hooks2.app) state5.app = hooks2.app;
        needsCtorsRederive = true;
        staleStreak = 0;
        debugState3.staleStreak = 0;
      } catch (error) {
        console.warn("[Snail with Skins] renderer health check failed", error);
      }
    }, RENDERER_HEALTH_CHECK_MS);
  }
  var RENDERER_HEALTH_CHECK_MS, REQUIRED_STALE_STREAK;
  var init_rendererHealth = __esm({
    "src/game/sprites/pixi/rendererHealth.ts"() {
      "use strict";
      init_pageContext();
      init_pixi();
      RENDERER_HEALTH_CHECK_MS = 1e3;
      REQUIRED_STALE_STREAK = 3;
    }
  });

  // src/game/sprites/utils/path.ts
  function normalizeSegments(path) {
    const out = [];
    for (const part2 of path.split("/")) {
      if (part2 === "" || part2 === ".") continue;
      if (part2 === "..") {
        out.pop();
        continue;
      }
      out.push(part2);
    }
    return out.join("/");
  }
  function animParse(key2) {
    const parts = splitKey(key2);
    const last = parts[parts.length - 1];
    const match = last && last.match(/^(.*?)(?:[_-])(\d{1,6})(\.[a-z0-9]+)?$/i);
    if (!match) return null;
    const baseName = (match[1] || "") + (match[3] || "");
    const idx = Number(match[2]);
    if (!baseName || !Number.isFinite(idx)) return null;
    return { baseKey: parts.slice(0, -1).concat(baseName).join("/"), idx, frameKey: key2 };
  }
  var splitKey, joinPath, dirOf, relPath;
  var init_path = __esm({
    "src/game/sprites/utils/path.ts"() {
      "use strict";
      splitKey = (key2) => String(key2 || "").split("/").filter(Boolean);
      joinPath = (base, path) => base.replace(/\/?$/, "/") + String(path || "").replace(/^\//, "");
      dirOf = (path) => path.lastIndexOf("/") >= 0 ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      relPath = (base, path) => typeof path === "string" ? normalizeSegments(path.startsWith("/") ? path.slice(1) : dirOf(base) + path) : path;
    }
  });

  // src/platform/environment.ts
  function isDiscordActivityContext() {
    try {
      return window.location.hostname.endsWith("discordsays.com");
    } catch {
      return false;
    }
  }
  function isInIframe() {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  }
  function hostOf(url) {
    if (!url) return null;
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
  function detectEnvironment() {
    const framed = isInIframe();
    const referrerHost = hostOf(document.referrer);
    const embeddedInDiscord = framed && !!referrerHost && /(^|\.)discord(app)?\.com$/i.test(referrerHost);
    return {
      surface: isDiscordActivityContext() || embeddedInDiscord ? "discord" : "web",
      host: location.hostname,
      origin: location.origin,
      isInIframe: framed,
      platform: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "mobile" : "desktop"
    };
  }
  function isDiscordSurface() {
    return detectEnvironment().surface === "discord";
  }
  var init_environment = __esm({
    "src/platform/environment.ts"() {
      "use strict";
    }
  });

  // src/platform/http.ts
  function hasGm() {
    return typeof GM_xmlhttpRequest === "function";
  }
  function gmRequest(req, kind) {
    return new Promise((resolve, reject2) => {
      if (!hasGm()) {
        reject2(new Error("GM_xmlhttpRequest not available"));
        return;
      }
      let deadline;
      if (req.timeoutMs) {
        deadline = setTimeout(
          () => reject2(new Error(`Hard timeout for ${req.url}`)),
          req.timeoutMs + HARD_DEADLINE_GRACE_MS
        );
      }
      const settle = () => clearTimeout(deadline);
      const details2 = {
        method: req.method ?? "GET",
        url: req.url,
        onload: (res) => {
          settle();
          const body = kind === "text" ? res.responseText : res.response;
          resolve({ status: res.status, ok: isOk(res.status), body: body ?? null });
        },
        onerror: () => {
          settle();
          reject2(new Error(`Network error for ${req.url}`));
        },
        ontimeout: () => {
          settle();
          reject2(new Error(`Timeout for ${req.url}`));
        }
      };
      if (kind !== "text") details2.responseType = kind;
      if (req.headers) details2.headers = req.headers;
      if (req.body !== void 0) details2.data = req.body;
      if (req.noCache) details2.nocache = true;
      if (req.timeoutMs) details2.timeout = req.timeoutMs;
      GM_xmlhttpRequest(details2);
    });
  }
  async function fetchRequest(req, kind) {
    const res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.body,
      cache: req.noCache ? "no-store" : void 0
    });
    const body = kind === "blob" ? await res.blob() : kind === "arraybuffer" ? await res.arrayBuffer() : await res.text();
    return { status: res.status, ok: res.ok, body };
  }
  async function request(req, kind) {
    if (req.preferGm) {
      if (hasGm()) {
        try {
          const res = await gmRequest(req, kind);
          if (res.ok) return res;
        } catch {
        }
      }
      return fetchRequest(req, kind);
    }
    if (isDiscordActivityContext()) return gmRequest(req, kind);
    try {
      return await fetchRequest(req, kind);
    } catch (error) {
      if (!hasGm()) throw error;
      return gmRequest(req, kind);
    }
  }
  async function getOk(url, kind, options2) {
    const res = await request({ ...options2, url }, kind);
    if (!res.ok || res.body == null) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.body;
  }
  async function getJSON(url, options2) {
    return JSON.parse(await getText(url, options2));
  }
  var HARD_DEADLINE_GRACE_MS, isOk, getText, getBlob;
  var init_http = __esm({
    "src/platform/http.ts"() {
      "use strict";
      init_environment();
      HARD_DEADLINE_GRACE_MS = 2e3;
      isOk = (status2) => status2 >= 200 && status2 < 300;
      getText = (url, options2) => getOk(url, "text", options2);
      getBlob = (url, options2) => getOk(url, "blob", options2);
    }
  });

  // src/game/sprites/data/assetFetcher.ts
  function blobToImage(blob) {
    return new Promise((resolve, reject2) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject2(new Error("decode fail"));
      };
      img.src = url;
    });
  }
  function isKtx2Path(path) {
    return typeof path === "string" && path.toLowerCase().endsWith(".ktx2");
  }
  function matchesManagedTexture(bt, imgName) {
    if (!bt) return false;
    const needle = imgName.toLowerCase();
    if (typeof bt.label === "string" && bt.label.toLowerCase().includes(needle)) return true;
    if (typeof bt.cacheId === "string" && bt.cacheId.toLowerCase().includes(needle)) return true;
    const resUrl = bt.resource?.url || bt.resource?.src || bt.source?.url || bt.source?.src || "";
    if (typeof resUrl === "string" && resUrl.toLowerCase().includes(needle)) return true;
    if (Array.isArray(bt.textureCacheIds)) {
      for (const id of bt.textureCacheIds) {
        if (typeof id === "string" && id.toLowerCase().includes(needle)) return true;
      }
    }
    return false;
  }
  function getManagedTextures(renderer) {
    const candidates = [
      renderer?.textureGC?.managedTextures,
      renderer?.texture?.managedTextures,
      renderer?.texture?._managedTextures,
      renderer?.textureSystem?.managedTextures
    ];
    for (const list of candidates) {
      if (Array.isArray(list) && list.length) return list;
    }
    return [];
  }
  async function loadKtx2AsTexture(imgName, renderer, ctors, timeoutMs = 3e3) {
    const root4 = pageWindow;
    const PIXI = root4.PIXI;
    if (PIXI?.Assets?.load) {
      try {
        return await PIXI.Assets.load({ src: imgName, loadParser: "loadTextures" });
      } catch {
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const managed = getManagedTextures(renderer);
      for (const bt of managed) {
        if (matchesManagedTexture(bt, imgName)) {
          if (ctors?.Texture && typeof bt.frame === "undefined" && typeof bt.width === "number") {
            try {
              return new ctors.Texture(bt);
            } catch {
            }
          }
          return bt;
        }
      }
      await new Promise((r) => root4.setTimeout(r, 250));
    }
    if (ctors?.Texture?.from) {
      for (const alias of [imgName, imgName.replace(/^.*\//, "")]) {
        try {
          const cached2 = ctors.Texture.from(alias);
          if (cached2 && cached2 !== ctors.Texture.EMPTY) return cached2;
        } catch {
        }
      }
    }
    throw new Error(`KTX2 base texture not found in renderer for "${imgName}"`);
  }
  function srcPath(entry) {
    if (typeof entry === "string") return entry;
    return typeof entry?.src === "string" && entry.src ? entry.src : null;
  }
  function srcResolution(entry) {
    if (typeof entry === "string") return 1;
    const value = Number(entry?.resolution);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }
  function isAtlasJsonPath(path) {
    return path.endsWith(".json") && path !== "manifest.json" && !path.startsWith("audio/");
  }
  function extractAtlasJsons(manifest) {
    const jsons = /* @__PURE__ */ new Set();
    for (const bundle of manifest.bundles || []) {
      for (const asset of bundle.assets || []) {
        let best = null;
        for (const entry of asset.src || []) {
          const path = srcPath(entry);
          if (!path || !isAtlasJsonPath(path)) continue;
          const resolution = srcResolution(entry);
          if (!best || resolution > best.resolution) best = { path, resolution };
        }
        if (best) jsons.add(best.path);
      }
    }
    return jsons;
  }
  async function loadAtlasJsons(base, manifest) {
    const jsons = extractAtlasJsons(manifest);
    const seen = /* @__PURE__ */ new Set();
    const data = {};
    const loadOne = async (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      const json = await getJSON2(joinPath(base, path));
      data[path] = json;
      if (json?.meta?.related_multi_packs) {
        for (const rel of json.meta.related_multi_packs) {
          await loadOne(relPath(path, rel));
        }
      }
    };
    for (const p of jsons) {
      await loadOne(p);
    }
    return data;
  }
  var ASSET_REQUEST, getJSON2, getBlob2;
  var init_assetFetcher = __esm({
    "src/game/sprites/data/assetFetcher.ts"() {
      "use strict";
      init_path();
      init_http();
      init_pageContext();
      ASSET_REQUEST = { preferGm: true, timeoutMs: 5e3 };
      getJSON2 = (url) => getJSON(url, ASSET_REQUEST);
      getBlob2 = (url) => getBlob(url, ASSET_REQUEST);
    }
  });

  // src/game/sprites/pixi/atlasToTextures.ts
  function mkRect(Rectangle, x, y, w, h2) {
    return new Rectangle(x, y, w, h2);
  }
  function mkSubTex(Texture, baseTex, frame, orig, trim, rotate, anchor) {
    let t;
    const src = baseTex?.source ?? baseTex?.baseTexture ?? baseTex;
    try {
      t = new Texture({ source: src, frame, orig, trim: trim || void 0, rotate: rotate || 0 });
    } catch {
      try {
        t = new Texture(src, frame, orig, trim || void 0, rotate || 0);
      } catch {
        t = new Texture(baseTex, frame, orig, trim || void 0, rotate || 0);
      }
    }
    try {
      if (t && !t.label) t.label = frame?.width && frame?.height ? `sub:${frame.width}x${frame.height}` : "subtex";
    } catch {
    }
    if (anchor) {
      const target = t;
      if (target.defaultAnchor?.set) {
        try {
          target.defaultAnchor.set(anchor.x, anchor.y);
        } catch {
        }
      }
      if (target.defaultAnchor && !target.defaultAnchor.set) {
        target.defaultAnchor.x = anchor.x;
        target.defaultAnchor.y = anchor.y;
      }
      if (!target.defaultAnchor) {
        target.defaultAnchor = { x: anchor.x, y: anchor.y };
      }
    }
    try {
      t?.updateUvs?.();
    } catch {
    }
    return t;
  }
  function buildAtlasTextures(data, baseTex, texMap, atlasBases, ctors) {
    const { Texture, Rectangle } = ctors;
    try {
      if (baseTex && !baseTex.label) baseTex.label = data?.meta?.image || "atlasBase";
    } catch {
    }
    rememberBaseTex(baseTex, atlasBases);
    for (const [k, fd] of Object.entries(data.frames)) {
      const fr = fd.frame;
      const rot = fd.rotated ? 2 : 0;
      const w = fd.rotated ? fr.h : fr.w;
      const h2 = fd.rotated ? fr.w : fr.h;
      const frame = mkRect(Rectangle, fr.x, fr.y, w, h2);
      const ss = fd.sourceSize || { w: fr.w, h: fr.h };
      const orig = mkRect(Rectangle, 0, 0, ss.w, ss.h);
      let trim = null;
      if (fd.trimmed && fd.spriteSourceSize) {
        const s = fd.spriteSourceSize;
        trim = mkRect(Rectangle, s.x, s.y, s.w, s.h);
      }
      const t = mkSubTex(Texture, baseTex, frame, orig, trim, rot, fd.anchor || null);
      try {
        t.label = k;
      } catch {
      }
      rememberBaseTex(t, atlasBases);
      texMap.set(k, t);
    }
  }
  var isAtlas;
  var init_atlasToTextures = __esm({
    "src/game/sprites/pixi/atlasToTextures.ts"() {
      "use strict";
      init_pixi();
      isAtlas = (j) => j && typeof j === "object" && j.frames && j.meta && typeof j.meta.image === "string";
    }
  });

  // src/game/gameVersion.ts
  function fromUrls(urls) {
    for (const url of urls) {
      const match = url && url.match(VERSION_IN_URL);
      if (match?.[1]) return match[1];
    }
    return null;
  }
  function fromGlobals() {
    const root4 = pageWindow;
    const gv = root4.gameVersion || root4.MG_gameVersion || root4.__SNAIL_SKINS_GAME_VERSION__;
    if (!gv) return null;
    try {
      if (typeof gv.getVersion === "function") return gv.getVersion() ? String(gv.getVersion()) : null;
      if (typeof gv.get === "function") return gv.get() ? String(gv.get()) : null;
      if (typeof gv === "string") return gv;
    } catch {
    }
    return null;
  }
  function detectGameVersion(doc) {
    if (gameVersion) return gameVersion;
    const d = doc ?? (typeof document !== "undefined" ? document : null);
    const scripts = d ? Array.from(d.scripts, (s) => s.src) : [];
    const links = d ? Array.from(d.querySelectorAll("link[href]"), (l) => l.href) : [];
    const found = fromUrls(scripts) ?? fromGlobals() ?? fromUrls(links);
    if (found) gameVersion = found;
    return found;
  }
  var gameVersion, VERSION_IN_URL;
  var init_gameVersion = __esm({
    "src/game/gameVersion.ts"() {
      "use strict";
      init_pageContext();
      gameVersion = null;
      VERSION_IN_URL = /\/(?:r\/\d+\/)?version\/([^/]+)/;
    }
  });

  // src/game/sprites/index.ts
  function whenAtlasBundleReady() {
    return atlasBundleReady;
  }
  function getAtlasBundle() {
    return atlasBundle;
  }
  async function waitForGameVersion(timeoutMs = 12e3) {
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      const version = detectGameVersion();
      if (version) return version;
      if (Date.now() >= deadline) throw new Error("Game version not found.");
      await sleep(120);
    }
  }
  async function prefetchAtlas(base) {
    try {
      const manifest = await getJSON2(joinPath(base, "manifest.json"));
      const atlasJsons = await loadAtlasJsons(base, manifest);
      const blobs = /* @__PURE__ */ new Map();
      for (const [path, data] of Object.entries(atlasJsons)) {
        if (!isAtlas(data) || !Object.keys(data.frames).some(key => categoryFor(key))) continue;
        const imgPath = relPath(path, data.meta.image);
        if (isKtx2Path(imgPath)) continue;
        try {
          blobs.set(imgPath, await getBlob2(joinPath(base, imgPath)));
        } catch {
        }
      }
      return { base, atlasJsons, blobs };
    } catch {
      return null;
    }
  }
  async function loadTextures(base, prefetched) {
    const usePrefetched = prefetched && prefetched.base === base ? prefetched : null;
    const atlasJsons = usePrefetched?.atlasJsons ?? await loadAtlasJsons(base, await getJSON2(joinPath(base, "manifest.json")));
    atlasBundle = usePrefetched ?? { base, atlasJsons, blobs: /* @__PURE__ */ new Map() };
    atlasBundleResolve?.(atlasBundle);
    atlasBundleResolve = null;
    const ctors = ctx.state.ctors;
    if (!ctors?.Texture || !ctors?.Rectangle) throw new Error("PIXI constructors missing");
    for (const [path, data] of Object.entries(atlasJsons)) {
      if (!isAtlas(data) || !Object.keys(data.frames).some(key => categoryFor(key))) continue;
      if (SKIPPED_ATLAS_PATTERNS.some((re) => re.test(path))) continue;
      const imgPath = relPath(path, data.meta.image);
      try {
        let baseTex;
        if (isKtx2Path(imgPath)) {
          baseTex = await loadKtx2AsTexture(imgPath, ctx.state.renderer, ctors);
        } else {
          const blob = usePrefetched?.blobs.get(imgPath) ?? await getBlob2(joinPath(base, imgPath));
          baseTex = ctors.Texture.from(await blobToImage(blob));
        }
        buildAtlasTextures(data, baseTex, ctx.state.tex, ctx.state.atlasBases, {
          Texture: ctors.Texture,
          Rectangle: ctors.Rectangle
        });
      } catch (error) {
        console.warn("[Snail with Skins] skipping atlas (texture load failed)", { path, imgPath, error });
      }
    }
    ctx.state.loaded = true;
  }
  function ensureDocumentReady() {
    if (document.readyState !== "loading") return Promise.resolve();
    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    });
  }
  async function start() {
    if (ctx.state.started) return;
    ctx.state.started = true;
    let version;
    try {
      version = await waitForGameVersion();
      console.info("[Snail with Skins] game version resolved", version);
    } catch (err) {
      console.error("[Snail with Skins] failed to resolve game version", err);
      throw err;
    }
    const base = `${ctx.cfg.origin.replace(/\/$/, "")}/version/${version}/assets/`;
    if (!prefetchPromise) prefetchPromise = prefetchAtlas(base);
    const { app, renderer: resolvedRenderer, version: pixiVersion } = await resolvePixiFast(hooks);
    await ensureDocumentReady();
    const renderer = resolvedRenderer || app?.renderer || app?.render || null;
    ctx.state.ctors = await waitForCtors(app, renderer);
    ctx.state.app = app;
    ctx.state.renderer = renderer;
    ctx.state.version = pixiVersion ?? version;
    ctx.state.base = base;
    watchRendererHealth(ctx.state, hooks);
    pageWindow.__SNAIL_SKINS_SPRITE_STATE__ = ctx.state;
    await loadTextures(ctx.state.base, await prefetchPromise);
    console.log("[Snail with Skins] ready", {
      version: ctx.state.version,
      pixi: version,
      textures: ctx.state.tex.size
    });
  }
  async function startWithRetry() {
    const RETRY_DELAY_MS = 2e3;
    for (; ; ) {
      try {
        await start();
        return;
      } catch (err) {
        console.error("[Snail with Skins] failed, retrying", err);
        ctx.state.started = false;
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  var ctx, hooks, prefetchPromise, atlasBundle, atlasBundleResolve, atlasBundleReady, SKIPPED_ATLAS_PATTERNS;
  var init_sprites = __esm({
    "src/game/sprites/index.ts"() {
      "use strict";
      init_pageContext();
      init_context();
      init_hooks();
      init_resolvePixi();
      init_rendererHealth();
      init_async();
      init_assetFetcher();
      init_atlasToTextures();
      init_path();
      init_gameVersion();
      ctx = spriteContext;
      hooks = createPixiHooks();
      setPixiHooks(hooks);
      prefetchPromise = null;
      atlasBundle = null;
      atlasBundleResolve = null;
      atlasBundleReady = new Promise((resolve) => {
        atlasBundleResolve = resolve;
      });
      SKIPPED_ATLAS_PATTERNS = [/(^|\/)weather(-\d+x)?\.json$/i];
      void startWithRetry();
    }
  });


const APP_NAME = 'Snail with Skins';
const CONFIG_KEY = 'snail-with-skins.v1';
const DEFAULT_RULE = Object.freeze({ hidden:false, opacity:1, scale:1, imageId:null });
const CATEGORIES = ['plant', 'mutation', 'mutation-overlay'];
const ownKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
const copy = value => JSON.parse(JSON.stringify(value));
function categoryFor(key) {
  const parts = String(key).split('/').filter(Boolean);
  if (['sprite','sprites'].includes(parts[0])) parts.shift();
  if (['plant','tall-plant','crop'].includes(parts[0])) return 'plant';
  return ['mutation','mutation-overlay'].includes(parts[0]) ? parts[0] : null;
}
function objectFor(key) {
  return String(key).replace(/[_-]\d{1,6}(?=(?:\.[a-z0-9]+)?$)/i, '');
}
function newConfig() { return { version:1, enabled:true, groups:{}, objects:{}, frames:{} }; }
function validRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('잘못된 스킨 설정입니다.');
  const rule = {};
  if (ownKey(raw,'hidden')) {
    if (typeof raw.hidden !== 'boolean') throw Error('숨기기 값이 잘못되었습니다.');
    rule.hidden = raw.hidden;
  }
  for (const [key,min,max] of [['opacity',0,1],['scale',0.1,3]]) {
    if (!ownKey(raw,key)) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key]<min || raw[key]>max) throw Error('투명도 또는 크기 범위를 확인하세요.');
    rule[key] = raw[key];
  }
  if (ownKey(raw,'imageId')) {
    if (raw.imageId !== null && (typeof raw.imageId !== 'string' || !/^img-[a-z0-9-]+$/i.test(raw.imageId))) throw Error('이미지 정보가 잘못되었습니다.');
    rule.imageId = raw.imageId;
  }
  return rule;
}
function readConfig(raw) {
  const out = newConfig();
  if (!raw || raw.version !== 1 || typeof raw.enabled !== 'boolean') throw Error('지원하지 않는 설정입니다.');
  out.enabled = raw.enabled;
  for (const scope of ['groups','objects','frames']) {
    if (!raw[scope] || typeof raw[scope] !== 'object' || Array.isArray(raw[scope])) throw Error('설정 목록이 잘못되었습니다.');
    for (const [key,value] of Object.entries(raw[scope])) {
      if (scope === 'groups' ? !CATEGORIES.includes(key) : !categoryFor(key)) continue;
      Object.defineProperty(out[scope], key, { value:validRule(value), enumerable:true, configurable:true, writable:true });
    }
  }
  return out;
}
function resolveRule(config, frameKey) {
  const category = categoryFor(frameKey);
  if (!category || !config.enabled) return { ...DEFAULT_RULE };
  return { ...DEFAULT_RULE, ...config.groups[category], ...config.objects[objectFor(frameKey)], ...config.frames[frameKey] };
}
function isEdited(rule) { return rule.hidden || rule.opacity !== 1 || rule.scale !== 1 || !!rule.imageId; }
function rectOf(texture) { return texture?.frame ?? texture?._frame; }
function sourceOfTexture(texture) { return texture?.source ?? texture?._source ?? texture?.baseTexture; }
function rectSignature(rect) { return rect && [rect.x,rect.y,rect.width,rect.height].join('|'); }
function atlasName(value) { return String(value || '').split(/[?#]/)[0].split('/').pop().replace(/\.(?:png|webp|ktx2|jpg)$/i,'').toLowerCase(); }
function atlasHints(source) {
  return [source?.label,source?.cacheId,source?.resource?.url,source?.resource?.src,source?.resource?._url,source?.resource?.source?.src,source?.resource?.src,source?.source?.src,...(source?.textureCacheIds || [])].map(atlasName).filter(Boolean);
}
function assignTextureSource(texture, source) {
  try { texture.source = source; } catch (_) {}
  if (sourceOfTexture(texture) === source) return true;
  for (const field of ['_source','baseTexture','_baseTexture']) {
    try { texture[field] = source; } catch (_) {}
    if (sourceOfTexture(texture) === source) return true;
  }
  return false;
}
function updateTexture(texture) {
  texture.updateUvs?.();
  texture.update?.();
  texture.emit?.('update', texture);
}
function patchTexture(texture, source, canvas, scale) {
  const frame = rectOf(texture);
  if (!frame || !source) return null;
  const snapshot = { texture, source:sourceOfTexture(texture), frame:{...frame}, orig:texture.orig && {...texture.orig}, trim:texture.trim && {...texture.trim}, rotate:texture.rotate, dynamic:texture.dynamic };
  if (!assignTextureSource(texture,source)) throw Error('게임 텍스처를 변경할 수 없습니다.');
  try {
    frame.x=0; frame.y=0; frame.width=canvas.width; frame.height=canvas.height;
    // Scale the logical bounds as well, so enlarging does not crop the image.
    if (texture.orig) {
      texture.orig.width = snapshot.orig.width * scale;
      texture.orig.height = snapshot.orig.height * scale;
    }
    if (texture.trim) {
      texture.trim.x = snapshot.trim.x * scale; texture.trim.y = snapshot.trim.y * scale;
      texture.trim.width=canvas.width; texture.trim.height=canvas.height;
    }
    texture.rotate=0;
    texture.dynamic=true;
    updateTexture(texture);
    return snapshot;
  } catch (error) { restoreTexture(snapshot); throw error; }
}
function restoreTexture(snapshot) {
  const {texture,source,frame,orig,trim,rotate,dynamic} = snapshot;
  if (texture.destroyed) return;
  if (!assignTextureSource(texture,source)) throw Error('원본 텍스처 복구에 실패했습니다.');
  Object.assign(rectOf(texture),frame);
  if (orig && texture.orig) Object.assign(texture.orig,orig);
  if (trim && texture.trim) Object.assign(texture.trim,trim);
  texture.rotate=rotate;
  updateTexture(texture);
  texture.dynamic=dynamic;
}
function targetsFrom(bundle) {
  const targets = new Map();
  for (const [path,data] of Object.entries(bundle.atlasJsons)) {
    for (const [key,fd] of Object.entries(data?.frames || {})) {
      if (!categoryFor(key) || !(fd.frame?.w>0 && fd.frame?.h>0)) continue;
      const fr=fd.frame;
      targets.set(key,{key,object:objectFor(key),category:categoryFor(key),atlas:atlasName(relPath(path,data.meta.image)),width:fr.w,height:fr.h,rect:{x:fr.x,y:fr.y,width:fd.rotated?fr.h:fr.w,height:fd.rotated?fr.w:fr.h}});
    }
  }
  return targets;
}
function createMatcher(targets, cachedTextures, snapshots = new Map()) {
  const identities=new Map(), byRect=new Map(), sourceAtlases=new Map();
  for (const target of targets.values()) {
    const texture=cachedTextures.get(target.key);
    if (texture) {
      identities.set(texture,target);
      const source=snapshots.get(texture)?.source ?? sourceOfTexture(texture);
      if (source) {
        if (!sourceAtlases.has(source)) sourceAtlases.set(source,new Set());
        sourceAtlases.get(source).add(target.atlas);
      }
    }
    const sig=rectSignature(target.rect);
    if (!byRect.has(sig)) byRect.set(sig,[]);
    byRect.get(sig).push(target);
  }
  return texture => {
    if (identities.has(texture)) return identities.get(texture);
    const label=texture?.label;
    if (targets.has(label)) return targets.get(label);
    const original=snapshots.get(texture);
    const source=original?.source ?? sourceOfTexture(texture);
    const names=new Set([...(sourceAtlases.get(source) || []),...atlasHints(source)]);
    const matches=(byRect.get(rectSignature(original?.frame ?? rectOf(texture))) || []).filter(t=>names.has(t.atlas));
    // Never guess from rectangle alone: pets/decor may use the same coordinates.
    return matches.length===1 ? matches[0] : null;
  };
}
function composeCanvas(target, image, rule) {
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(target.width*rule.scale));
  canvas.height=Math.max(1,Math.round(target.height*rule.scale));
  if (canvas.width*canvas.height>16*1024*1024) throw Error('이미지가 너무 큽니다. 크기를 줄여 주세요.');
  const ctx=canvas.getContext('2d');
  if (!ctx) throw Error('이미지 그리기를 사용할 수 없습니다.');
  if (rule.hidden || rule.opacity===0) return canvas;
  if (!image) throw Error('원본 이미지를 읽지 못했습니다. 다시 연결해 주세요.');
  const fit=Math.min(canvas.width/image.width,canvas.height/image.height);
  const w=image.width*fit,h=image.height*fit;
  ctx.imageSmoothingEnabled=fit<1;
  ctx.globalAlpha=rule.opacity;
  ctx.drawImage(image,(canvas.width-w)/2,(canvas.height-h)/2,w,h);
  return canvas;
}

// Keep pure configuration and texture operations directly testable in Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports={newConfig,readConfig,resolveRule,categoryFor,objectFor,createMatcher,patchTexture,restoreTexture,composeCanvas};
} else {
  void bootSkins();
}

async function bootSkins() {
  const root=typeof unsafeWindow!=='undefined' && unsafeWindow ? unsafeWindow : window;
  if (root.__SNAIL_WITH_SKINS__) return;
  const api={version:'1.0.0'};
  root.__SNAIL_WITH_SKINS__=api;
  let config=newConfig(), targets=new Map(), selectedCategory='plant', selectedObject='', query='';
  let database, ui, lastRenderer, revision=0, work=Promise.resolve(), applying=false;
  let assets=new Map(), snapshots=new Map(), generated=new Map(), originals=new Map(), appliedNodes=new Set();
  let status='게임과 이미지 목록을 기다리는 중…', error='', cacheNotice='';
  try { const stored=localStorage.getItem(CONFIG_KEY); if (stored) config=readConfig(JSON.parse(stored)); }
  catch (e) { error=`저장된 설정을 불러오지 못했습니다: ${e.message}`; }
  init_sprites();
  // Frames can be decoded before the sprite bridge finishes its atlas pass.
  api.ready=false;
  api.getConfig=()=>copy(config);
  api.setEnabled=on=>{config.enabled=!!on;change();render();return work;};
  api.refresh=()=>queueApply();
  let panelOpen=false,publishedEnabled=config.enabled;
  api.setPanelOpen=on=>{panelOpen=!!on;if(ui){ui.panel.hidden=!panelOpen;if(panelOpen)render();}};
  root.dispatchEvent(new Event('snail-with-skins:config-change'));
  function save() {
    try { localStorage.setItem(CONFIG_KEY,JSON.stringify(config)); }
    catch (e) { throw Error(`설정을 저장하지 못했습니다: ${e.message}`); }
  }
  function change() {
    if(publishedEnabled!==config.enabled){publishedEnabled=config.enabled;root.dispatchEvent(new Event('snail-with-skins:config-change'));}
    revision++;
    try { save(); } catch (e) { report(e); }
    queueApply();
  }
  function report(e) { error=e.message || String(e); renderStatus(); console.warn(`[${APP_NAME}]`,e); }
  function queueApply() {
    const version=revision;
    work=work.then(()=>applyAll(version)).catch(report);
    return work;
  }
  async function openImages() {
    database=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('snail-with-skins',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('images',{keyPath:'id'});
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('다른 게임 탭을 닫고 다시 시도해 주세요.'));
    });
    return imageTransaction('readonly',store=>store.getAll());
  }
  function imageTransaction(mode,action) {
    if (!database) return Promise.reject(Error('이미지 저장소가 준비되지 않았습니다. 다시 연결해 주세요.'));
    return new Promise((resolve,reject)=>{
      const tx=database.transaction('images',mode), req=action(tx.objectStore('images'));
      tx.oncomplete=()=>resolve(req.result);
      tx.onabort=tx.onerror=()=>reject(tx.error || req.error || Error('이미지를 저장하지 못했습니다.'));
    });
  }
  async function upload(scope,key,file) {
    if (!file) return;
    if (file.size>4*1024*1024) throw Error('이미지는 4MB 이하로 선택해 주세요.');
    const bitmap=await createImageBitmap(file);
    if (bitmap.width*bitmap.height>16*1024*1024) { bitmap.close?.(); throw Error('이미지 해상도가 너무 큽니다.'); }
    const id=`img-${crypto.randomUUID()}`;
    try { await imageTransaction('readwrite',store=>store.put({id,blob:file})); }
    catch (e) { bitmap.close?.(); throw e; }
    assets.set(id,bitmap);
    config[scope][key]={...config[scope][key],imageId:id};
    change(); render();
    // Images no longer referenced by any setting are reclaimed after a successful save.
    const used=new Set(['groups','objects','frames'].flatMap(s=>Object.values(config[s]).map(r=>r.imageId)).filter(Boolean));
    for (const [old,image] of assets) if (!used.has(old)) {
      await imageTransaction('readwrite',store=>store.delete(old)); image.close?.(); assets.delete(old);
    }
  }
  function cacheTexture(key) {
    const Texture=getSpriteState().ctors?.Texture;
    try { const t=Texture?.from(key); if (t && t!==Texture.EMPTY && rectOf(t)) return t; } catch (_) {}
    for (const cache of [root.PIXI?.Assets,root.PIXI?.Cache]) {
      try { const t=cache?.get?.(key); if (t && rectOf(t)) return t; } catch (_) {}
    }
    return null;
  }
  function walkSprites() {
    const state=getSpriteState(), nodes=[], seen=new Set();
    const stack=[state.app?.stage,state.renderer?.lastObjectRendered,state.renderer?.stage];
    while (stack.length && seen.size<40000) {
      const node=stack.pop();
      if (!node || seen.has(node) || node.destroyed) continue;
      seen.add(node);
      if (node.texture && rectOf(node.texture)) nodes.push(node);
      if (Array.isArray(node.children)) for (const child of node.children) stack.push(child);
    }
    return nodes;
  }
  function poke(node) {
    if (!node || node.destroyed) return;
    try {
      const t=node.texture, empty=getSpriteState().ctors?.Texture?.EMPTY;
      if (empty && t && t!==empty) {node.texture=empty;node.texture=t;}
      else node.onViewUpdate?.();
    } catch (_) {}
  }
  function rebake() {
    const state=getSpriteState();
    const queue=[getPixiApp(),state.app,state.renderer,root.__PIXI_APP__,root.app];
    const seen=new Set();
    while (queue.length && seen.size<400) {
      const holder=queue.shift();
      if (!holder || typeof holder!=='object' || seen.has(holder)) continue;
      seen.add(holder);
      if (typeof holder.renderTextureCache?.rebakeAll==='function') {
        holder.renderTextureCache.rebakeAll(); cacheNotice=''; return true;
      }
      for (const key of ['app','engine','game','renderer','stage','_app','quinoa']) if (holder[key]) queue.push(holder[key]);
    }
    cacheNotice='변이 합성 캐시를 찾지 못했습니다. 이미 합성된 변이 식물은 변경이 늦게 보일 수 있습니다.';
    return false;
  }
  function restoreAll() {
    const failed=[];
    for (const [texture,snapshot] of snapshots) {
      try { restoreTexture(snapshot);snapshots.delete(texture); } catch (e) {failed.push(e);}
    }
    for (const node of appliedNodes) poke(node);
    appliedNodes.clear();
    if (failed.length) throw failed[0];
    // GPU sources may only be released after all users of them are restored.
    for (const entry of generated.values()) entry.texture.destroy?.(true);
    generated.clear();
  }
  async function originalImage(target) {
    if (originals.has(target.key)) return originals.get(target.key);
    const state=getSpriteState(), texture=state.tex.get(target.key);
    if (!texture || !state.renderer?.extract) return null;
    const sprite=new state.ctors.Sprite(texture);
    try {
      const extracted=await state.renderer.extract.canvas(sprite,{resolution:1});
      // Extract can return a pooled canvas; keep an independent copy.
      const canvas=document.createElement('canvas');canvas.width=extracted.width;canvas.height=extracted.height;
      canvas.getContext('2d').drawImage(extracted,0,0);
      originals.set(target.key,canvas);return canvas;
    } finally {sprite.destroy?.({texture:false,baseTexture:false});}
  }
  async function applyAll(version) {
    if (!api.ready || version!==revision) return;
    applying=true; error='';renderStatus();
    try {
      restoreAll();
      if (!config.enabled) {rebake();status='전체 적용 OFF · 원래 모습으로 표시합니다.';return;}
      const state=getSpriteState();
      for (const target of targets.values()) {
        const rule=resolveRule(config,target.key);
        if (!isEdited(rule)) continue;
        const image=rule.imageId ? assets.get(rule.imageId) : rule.hidden || rule.opacity===0 ? null : await originalImage(target);
        if (version!==revision) return;
        if (rule.imageId && !image && !rule.hidden && rule.opacity!==0) throw Error('저장된 스킨 이미지를 읽지 못했습니다. 이미지를 다시 선택해 주세요.');
        const canvas=composeCanvas(target,image,rule);
        const texture=state.ctors.Texture.from(canvas);
        generated.set(target.key,{texture,canvas,rule});
      }
      if (version!==revision) return;
      applyDiscovered();
      if (!generated.size) status='전체 적용 ON · 기본 게임 이미지로 표시합니다.';
    } finally { applying=false;renderStatus(); }
  }
  function applyDiscovered() {
    if (!config.enabled || !generated.size) return;
    const cached=new Map();
    for (const key of targets.keys()) {const texture=cacheTexture(key);if (texture) cached.set(key,texture);}
    const match=createMatcher(targets,cached,snapshots);
    const nodes=walkSprites();
    const candidates=new Set([...cached.values(),...nodes.map(n=>n.texture)]);
    const catalog=new Set(getSpriteState().tex.values());
    let changed=false;
    for (const texture of candidates) {
      if (snapshots.has(texture) || catalog.has(texture) || texture.destroyed) continue;
      const target=match(texture), entry=target && generated.get(target.key);
      if (!entry) continue;
      const snapshot=patchTexture(texture,sourceOfTexture(entry.texture),entry.canvas,entry.rule.scale);
      if (snapshot) {snapshots.set(texture,snapshot);changed=true;}
    }
    for (const node of nodes) if (snapshots.has(node.texture)) {if (!appliedNodes.has(node)) poke(node);appliedNodes.add(node);}
    for (const node of appliedNodes) if (node.destroyed || !node.parent) appliedNodes.delete(node);
    for (const texture of snapshots.keys()) if (texture.destroyed) snapshots.delete(texture);
    if (changed) rebake();
    api.appliedTextures=snapshots.size;
    status=generated.size && !snapshots.size
      ? `전체 적용 ON · ${generated.size}개 프레임 준비됨 · 게임에 표시될 때 적용합니다.`
      : `전체 적용 ON · ${generated.size}개 프레임 설정 · ${snapshots.size}개 텍스처에 적용`;
    renderStatus();
  }
  async function connect() {
    try {
      status='게임 이미지 목록을 불러오는 중…';renderStatus();
      const bundle=await whenAtlasBundleReady();
      // Atlas metadata is published before its textures finish loading.
      while (!getSpriteState().loaded) await new Promise(r=>setTimeout(r,150));
      targets=targetsFrom(bundle);
      if (!targets.size) throw Error('지원하는 Plant / Mutation 이미지를 찾지 못했습니다.');
      api.ready=true;api.targetCount=targets.size;lastRenderer=getSpriteState().renderer;
      render();await queueApply();
    } catch(e) {report(e);}
  }
  await new Promise(resolve=>{if (document.body) resolve();else document.addEventListener('DOMContentLoaded',resolve,{once:true});});
  mountUI();
  try {
    const rows=await openImages();
    for (const row of rows) {
      try {assets.set(row.id,await createImageBitmap(row.blob));} catch (_) {error='일부 저장된 이미지를 읽지 못했습니다. 다시 선택해 주세요.';}
    }
  } catch(e) {report(e);}
  void connect();
  setInterval(()=>{
    if (!api.ready || applying) return;
    const current=getSpriteState().renderer;
    if (current && current!==lastRenderer) {
      lastRenderer=current;originals.clear();revision++;queueApply();
    } else {
      try {applyDiscovered();} catch(e) {report(e);}
    }
  },1500);

  function element(tag,text,className) {
    const el=document.createElement(tag);if (text!==undefined) el.textContent=text;if (className) el.className=className;return el;
  }
  function button(text,fn,className) {
    const el=element('button',text,className);el.type='button';
    el.onclick=()=>Promise.resolve().then(fn).catch(report);return el;
  }
  function mountUI() {
    const host=element('div');host.id='snail-with-skins';document.body.append(host);
    const shadow=host.attachShadow({mode:'open'});
    const style=element('style');style.textContent=SKINS_CSS;shadow.append(style);

    const panel=element('section',undefined,'panel');panel.hidden=!panelOpen;panel.setAttribute('aria-label',APP_NAME);
    const header=element('header');header.append(element('strong',APP_NAME),button('닫기',()=>api.setPanelOpen(false)));
    const toggle=button('',()=>api.setEnabled(!config.enabled),'master');toggle.setAttribute('role','switch');
    const tabs=element('nav');
    for (const c of CATEGORIES) tabs.append(button(c==='plant'?'Plant':c==='mutation'?'Mutation':'Mutation-overlay',()=>{selectedCategory=c;selectedObject='';render();}));
    const help=element('p','개별 프레임 > 개별 식물/변이 > 전체 설정 · 투명도 100%는 완전 투명','hint');
    const global=element('div',undefined,'global'), search=element('input');search.type='search';search.placeholder='이름 검색';search.setAttribute('aria-label','이름 검색');
    search.oninput=()=>{query=search.value;renderList();};
    const list=element('div',undefined,'list'), detail=element('div',undefined,'detail');
    const browser=element('div',undefined,'browser');browser.append(search,list);
    const panes=element('div',undefined,'panes');panes.append(browser,detail);
    const statusEl=element('div',undefined,'status');statusEl.setAttribute('role','status');statusEl.setAttribute('aria-live','polite');
    const footer=element('footer');footer.append(button('다시 적용',()=>{revision++;queueApply();}),button('전체 설정 초기화',()=>{
      if (!window.confirm('전체 스킨 설정을 초기화할까요?')) return;
      config=newConfig();change();render();
    }));
    panel.append(header,toggle,tabs,help,global,panes,statusEl,footer);shadow.append(panel);
    ui={host,shadow,panel,toggle,tabs,global,list,detail,statusEl};render();
    shadow.addEventListener('keydown',event=>{if (event.key==='Escape') {api.setPanelOpen(false);document.querySelector('#snail-in-cherry')?.shadowRoot?.querySelector('.menu-link')?.focus();}});
  }
  function renderStatus() {
    if (!ui) return;
    ui.statusEl.textContent=[error,applying?'변경 사항을 적용하는 중…':status,cacheNotice].filter(Boolean).join('\n');
    ui.statusEl.classList.toggle('error',!!error);
    ui.toggle.textContent=`전체 적용 ${config.enabled?'ON':'OFF'}`;
    ui.toggle.setAttribute('aria-checked',String(config.enabled));
    ui.toggle.classList.toggle('on',config.enabled);

  }
  function groups() {
    const result=new Map();
    for (const t of targets.values()) if (t.category===selectedCategory) {
      if (!result.has(t.object)) result.set(t.object,[]);result.get(t.object).push(t);
    }
    return [...result].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true}));
  }
  function name(key) {return key.split('/').pop();}
  function renderList() {
    ui.list.replaceChildren();
    const filtered=groups().filter(([key])=>key.toLowerCase().includes(query.toLowerCase()));
    if (!filtered.length) ui.list.append(element('p',api.ready?'검색 결과가 없습니다.':'게임 이미지 대기 중…','hint'));
    for (const [key,slots] of filtered) {
      const custom=ownKey(config.objects,key) || slots.some(t=>ownKey(config.frames,t.key));
      const el=button(`${name(key)}${custom?' · 개별':''}`,()=>{selectedObject=key;renderList();renderDetail();},key===selectedObject?'selected':'');
      el.title=key;ui.list.append(el);
    }
  }
  function render() {
    if (!ui) return;
    [...ui.tabs.children].forEach((el,i)=>{el.classList.toggle('selected',CATEGORIES[i]===selectedCategory);el.setAttribute('aria-pressed',String(CATEGORIES[i]===selectedCategory));});
    ui.global.replaceChildren(element('h3',`${selectedCategory==='plant'?'Plant (작물·식물) 전체':selectedCategory+' 전체'} 설정`));
    ui.global.append(ruleEditor('groups',selectedCategory,null));
    renderList();renderDetail();renderStatus();
  }
  function renderDetail() {
    ui.detail.replaceChildren();
    const entry=groups().find(([key])=>key===selectedObject);
    if (!entry) {ui.detail.append(element('p','이름을 선택하면 개별 설정과 성장 단계별 스킨을 변경할 수 있습니다.','hint'));return;}
    const [key,slots]=entry;
    ui.detail.append(element('h3',name(key)),ruleEditor('objects',key,slots[0].key));
    if (slots.length>1) ui.detail.append(element('p','성장 단계 / 프레임별 설정','hint'));
    for (const target of slots) {
      const block=element('details');block.open=slots.length===1;
      block.append(element('summary',`${name(target.key)} · ${target.width}×${target.height}`));
      block.append(ruleEditor('frames',target.key,target.key));
      ui.detail.append(block);
    }
  }
  function ruleEditor(scope,key,frameKey) {
    const box=element('div',undefined,'editor');
    const inherited=scope!=='groups' && !ownKey(config[scope],key);
    const enabledConfig={...config,enabled:true};
    const effective=scope==='groups' ? {...DEFAULT_RULE,...config.groups[key]} : scope==='objects' ? {...DEFAULT_RULE,...config.groups[categoryFor(key)],...config.objects[key]} : resolveRule(enabledConfig,frameKey);
    if (scope!=='groups') {
      const row=element('label',undefined,'check'), check=element('input');check.type='checkbox';check.checked=!inherited;
      check.onchange=()=>{
        if (check.checked) config[scope][key]={...effective};else delete config[scope][key];
        change();render();
      };
      row.append(check,element('span',scope==='objects'?'개별 설정 사용 (전체보다 우선)':'이 프레임만 설정 (가장 우선)'));box.append(row);
    }
    const fields=element('fieldset');fields.disabled=inherited;
    const hideLabel=element('label',undefined,'check'), hide=element('input');hide.type='checkbox';hide.checked=effective.hidden;
    hide.onchange=()=>update({hidden:hide.checked});hideLabel.append(hide,element('span','숨기기'));fields.append(hideLabel);
    slider('투명도',Math.round((1-effective.opacity)*100),0,100,1,value=>({opacity:Number((1-value/100).toFixed(2))}));
    slider('크기',Math.round(effective.scale*100),10,300,5,value=>({scale:value/100}));
    const imageRow=element('div',undefined,'image-row');
    const file=element('input');file.type='file';file.accept='image/png,image/webp,image/jpeg,image/gif';file.hidden=true;
    file.onchange=()=>{const selected=file.files[0];void upload(scope,key,selected).catch(report);file.value='';};
    const pick=button(effective.imageId?'스킨 이미지 바꾸기':'스킨 이미지 추가',()=>file.click());
    imageRow.append(pick,file,button('기본 이미지',()=>{update({imageId:null});render();}));
    fields.append(imageRow,element('p',effective.imageId?'추가한 스킨에도 숨기기·투명도·크기가 적용됩니다.':'기본 게임 이미지에 숨기기·투명도·크기가 적용됩니다.','hint'));
    if (frameKey && assets.has(effective.imageId)) {
      const target=targets.get(frameKey),preview=composeCanvas(target,assets.get(effective.imageId),{...effective,scale:1});preview.className='preview';fields.append(preview);
    }
    if (scope==='groups') fields.append(button('이 전체 설정 초기화',()=>{delete config.groups[key];change();render();}));
    box.append(fields);return box;
    function update(patch) {
      config[scope][key]={...config[scope][key],...patch};change();
      if (scope==='groups') renderDetail();
    }
    function slider(label,value,min,max,step,patch) {
      const row=element('label',undefined,'slider'),text=element('span',label),output=element('output',`${value}%`),input=element('input');
      input.type='range';input.min=min;input.max=max;input.step=step;input.value=value;input.setAttribute('aria-label',label);
      input.oninput=()=>output.textContent=`${input.value}%`;
      input.onchange=()=>update(patch(Number(input.value)));
      row.append(text,input,output);fields.append(row);
    }
  }
}

const SKINS_CSS = `
:host{all:initial;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8ecf1;position:fixed;z-index:2147483646;right:18px;bottom:20px;color-scheme:dark}
*{box-sizing:border-box} [hidden]{display:none!important}
button,input{font:inherit}button{cursor:pointer;border:1px solid #40534d;border-radius:9px;padding:7px 11px;background:#24332d;color:#e8ecf1;transition:background .12s}button:hover{background:#334d40}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #b5e79f;outline-offset:2px}
.launcher{background:#bedc9b;color:#1c2c20;font-weight:750;box-shadow:0 4px 22px #0007;padding:11px 16px}.launcher.off{background:#777f79;color:white}
.panel{position:absolute;right:0;bottom:54px;width:min(850px,calc(100vw - 24px));height:min(820px,calc(100dvh - 100px));display:flex;flex-direction:column;background:#17231e;border:1px solid #536b59;border-radius:16px;box-shadow:0 16px 60px #0009;overflow:hidden;padding:16px;gap:10px}
header{display:flex;align-items:center;justify-content:space-between;gap:10px}header strong{font-size:20px;letter-spacing:-.4px}header button{font-size:12px}.master{font-weight:800;background:#3b4540}.master.on{background:#b4d88d;color:#17281b;border-color:#b4d88d}nav{display:flex;gap:6px;flex-wrap:wrap}.selected{background:#536c46!important;color:#f1ffe8!important;border-color:#a5c08b!important}
p,h3{margin:0}h3{font-size:14px;font-weight:750}.hint{font-size:12px;color:#acb9ae}.global{background:#202f26;border-radius:10px;padding:10px}.global .editor fieldset{display:grid;grid-template-columns:100px 1fr 1fr;gap:8px 16px;align-items:center}.global .image-row,.global .hint{grid-column:1/-1}.global fieldset>button{grid-column:1/-1;justify-self:start;font-size:12px}
.panes{display:grid;grid-template-columns:210px 1fr;gap:12px;min-height:100px;flex:1;overflow:hidden}.browser{display:flex;flex-direction:column;gap:8px;min-height:0}.browser input{width:100%;border:1px solid #40534d;border-radius:8px;background:#101b16;color:#f2f6ed;padding:8px}.list{overflow:auto;display:flex;flex-direction:column;gap:5px;min-height:0;padding:2px}.list button{text-align:left;overflow-wrap:anywhere;font-size:13px}.detail{overflow:auto;background:#122019;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}.editor fieldset{border:0;margin:0;padding:7px 0;min-width:0;display:flex;flex-direction:column;gap:10px}.editor fieldset:disabled{opacity:.42}.check{display:flex;gap:7px;align-items:center;font-size:13px}.check input{accent-color:#bedc9b}.slider{display:grid;grid-template-columns:50px minmax(60px,1fr) 45px;gap:6px;align-items:center;font-size:12px}.slider input{width:100%;accent-color:#c8e9a5}.slider output{text-align:right;font-variant-numeric:tabular-nums}.image-row{display:flex;gap:6px;flex-wrap:wrap}.image-row button{font-size:12px}.preview{width:72px;height:72px;object-fit:contain;image-rendering:pixelated;background:repeating-conic-gradient(#425045 0 25%,#25342b 0 50%) 0/14px 14px;border-radius:7px}details{border-top:1px solid #324539;padding-top:8px}summary{cursor:pointer;font-size:12px;overflow-wrap:anywhere}.status{font-size:12px;color:#b6c5b4;white-space:pre-line;max-height:75px;overflow:auto}.status.error{color:#ffc1ab}footer{display:flex;justify-content:space-between;gap:8px}footer button{font-size:12px}
@media(max-width:600px){:host{right:12px;bottom:14px}.panel{padding:12px;gap:8px}.panes{grid-template-columns:125px 1fr;gap:7px}.detail{padding:9px}.global .editor fieldset{grid-template-columns:1fr}.global .image-row,.global .hint,.global fieldset>button{grid-column:auto}.global .editor fieldset>.hint{display:none}header strong{font-size:18px}nav button{padding:6px 8px;font-size:12px}.list button{padding:7px;font-size:12px}.slider{grid-template-columns:40px minmax(40px,1fr) 38px;gap:3px}}
`;

})();

}
// END embedded Snail with Skins
