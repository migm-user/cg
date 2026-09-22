// ==UserScript==
// @name         Snail in Cherry
// @namespace    snail-in-cherry
// @author       0_"
// @version      1.4.5
// @description  독립 상점 구매·알 심기·부화·펫 판매·펫 먹이와 설정 백업
// @match        https://1227719606223765687.discordsays.com/*
// @match        https://magiccircle.gg/r/*
// @match        https://magicgarden.gg/r/*
// @match        https://starweaver.org/r/*
// @run-at       document-start
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
  const VERSION = '1.4.5', KEY = 'snail-in-cherry.settings.v1';
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
  // Public /data verified 2026-09-22; used only when catalog fields are absent.
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
    return {storage,storageId,held,amount:Math.min(amount,quantity(entry)),itemKey:item.itemType==='Tool' ? entry.id || itemId(entry) : itemId(entry)};
  }
  const defaults = () => ({
    autoBuy: false, autoStore: false, autoFeed: false, buy: {},
    feed: { hungerPotion:true,allowed:{},openEggs:[],openPets:[],webhook:{enabled:false,url:''} },
    eggs: { order: [], enabled: {}, direction: '좌' },
    protect: { gold: false, rainbow: false, str: false, threshold: 95 },
    teams: { hatch: '', sell: '', restore: 'current' },
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
    for (const key of ['autoBuy', 'autoStore', 'autoFeed']) bool(raw, key, s);
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
  function stock(root, data, shop, id, staleMarker = '') {
    const item = root?.child?.data?.shops?.[shop]?.inventory?.find(i => itemId(i) === id);
    const record = data?.shopPurchases?.[shop];
    const stale = staleMarker && staleMarker === JSON.stringify(record || {});
    const bought = stale ? 0 : Number(record?.purchases?.[id] || 0);
    return { item, bought, available: item && finite(item.initialStock) ? Math.max(0,item.initialStock-bought) : 0, epoch: Number(record?.createdAt || 0) };
  }
  const members = team => (Array.isArray(team?.members) ? team.members : []).map(m => String(m?.petId || '')).filter(Boolean).sort();
  // Native v1240 teams are part of the current player's authoritative data.
  const nativeTeams = data => Array.isArray(data?.petTeams) ? data.petTeams.filter(t=>t && typeof t.id==='string' && t.id.trim()) : null;
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
        const state=this.atom('stateAtom'),player=this.atom('playerAtom');if(!state)return null;
        const root=this.get(state),me=player?this.get(player):null;
        if(me?.id && selfId && String(me.id)!==String(selfId))return null;
        if(root?.data?.roomSessionId && roomState?.data?.roomSessionId && root.data.roomSessionId!==roomState.data.roomSessionId)return null;
        return nativeTeams(mySlot(root,me?.id || selfId)?.data);
      }catch{return null;}
    }
    async connect() {
      if(this.get)return true;
      if(this.pending)return this.pending;
      this.pending=this.capture().finally(()=>{this.pending=null;});return this.pending;
    }
    async capture() {
      const cache=this.page.jotaiAtomCache?.cache;if(!cache?.values || !this.atom('stateAtom'))return false;
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
            for(const atom of [this.atom('stateAtom'),this.atom('playerAtom')].filter(Boolean))this.unsub.push(store.sub(atom,changed));
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
              payload = JSON.stringify({ ...msg, commandSequence: seq });
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
    }
    observeShops() {
      const purchases = mySlot(this.root,this.selfId)?.data?.shopPurchases;
      const events={restocked:[],eggPurchases:[]};
      for (const [shop,value] of Object.entries(this.root?.child?.data?.shops || {})) {
        if (!value) continue;
        const left = Number(value.secondsUntilRestock), marker = JSON.stringify(purchases?.[shop] || {});
        const previous = this.shopWatch.get(shop);
        const inventorySignature=JSON.stringify(value.inventory||[]);
        const changedInventory=previous && previous.inventorySignature!==inventorySignature;
        const resetDetected = previous && ((Number.isFinite(left) && Number.isFinite(previous.left) && left > previous.left+2) || changedInventory);
        // Inventory and countdown can arrive in separate frames for one restock.
        const restocked=resetDetected && (!previous.lastRestockAt || Date.now()-previous.lastRestockAt>3000);
        let stale = previous?.stale || '';
        if (restocked && previous.marker === marker) stale = marker;
        if (stale && stale !== marker) stale = '';
        const record=purchases?.[shop]||{},counts={...(record.purchases||{})},epoch=Number(record.createdAt||0);
        if(restocked)events.restocked.push(shop);
        if(previous && !stale)for(const item of value.inventory||[]) {
          if(item?.itemType!=='Egg')continue;
          const id=itemId(item),before=(previous.stale || previous.epoch!==epoch)?0:Number(previous.counts?.[id]||0);
          if(Number(counts[id]||0)>before)events.eggPurchases.push({shop,id,quantity:Number(counts[id])-before});
        }
        this.shopWatch.set(shop,{left,marker,stale,counts,epoch,inventorySignature,lastRestockAt:restocked?Date.now():previous?.lastRestockAt||0,cycle:(previous?.cycle || 0)+(restocked ? 1 : 0)});
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
  const exported = { settingsFrom,parseSettings,defaults,orderedTiles,applyPatches,mySlot,maxStrength,saleReason,readyEgg,stock,GameLink,NativeGameTeams,members,activeIds,sameIds,webhookURL,purchaseCapacity,storagePlan,hungerPercent,hungryStage,petFoodGroups,chooseFood,petPosition };
  if (typeof module === 'object' && module.exports) { module.exports = exported; return; }
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (page.__SNAIL_IN_CHERRY__) return;
  page.__SNAIL_IN_CHERRY__ = VERSION;
  let settings;
  try { settings = settingsFrom(GM_getValue(KEY,defaults())); } catch { settings = defaults(); }
  let catalog = {}, catalogAt = 0, catalogPromise = null, catalogRetryAt = 0, catalogETag = '', running = null, status = '게임 연결 대기', view = 'home';
  let liveInfo={},liveAt=0,livePromise=null,liveRetryAt=0;
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
    if(event?.uiChanged || event?.restocked?.length)schedulePaint();
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
        const key=food.id || food.toolId,prior=quantity(food);
        // Food UUIDs are retained by retrieval; potions may merge into an existing stack.
        const owned=food.itemType==='Tool'?purchaseCapacity(data,food).held:quantity(data.inventory.items.find(i=>i?.id===food.id) || {quantity:0});
        await game.command('RetrieveItemFromStorage',{itemId:key,storageId:selected.storageId,quantity:1},next=> {
          const source=next.inventory.storages?.find(s=>(s.decorId || s.id)===selected.storageId);
          const left=storageItems(source).find(i=>(i.id || i.toolId)===key);
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
        for (let i=0; i<target; i++) {
          checkJob(job);
          if (!settings.buy[choiceKey(item)]) break;
          const data = game.data(), before = game.stock(shop,id);
          const capacity=purchaseCapacity(data,before.item || item,meta(type,id));
          if (!capacity.remaining) { reason=`소지 한도 ${capacity.held}/${capacity.limit} · 추가 구매 건너뜀`; break; }
          if (!before.available) { reason='재고 부족'; break; }
          if (before.cycle !== initial.cycle) { reason='재입고 감지 · 다음 검사에서 계속'; break; }
          const price = before.item.coinPrice ?? meta(type,id).coinPrice;
          if (finite(price) && finite(data.coinsCount) && data.coinsCount < price) { reason='잔액 부족'; break; }
          if (data.inventory.items.filter(Boolean).length >= CAPACITY && !data.inventory.items.some(i => i?.itemType === type && itemId(i) === id)) { reason='인벤토리 가득 참'; break; }
          report(`${title(type,id)} 구매 중 · ${confirmed}/${target}`);
          sent++;
          // As in Arie's Mod: one purchase request per unit, no per-unit random delay.
          // Wait only for the authoritative acknowledgement and stock change.
          await game.command('PurchaseShopItem',{ shop,item:{ itemType:type,[FIELDS[type]]:id } },next => {
            const after = game.stock(shop,id);
            return after.cycle === before.cycle && after.bought > before.bought &&
              (!(Number.isFinite(capacity.limit) || settings.autoStore) || purchaseCapacity(next,item,meta(type,id)).held > capacity.held);
          });
          confirmed++;
        }
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
    }
    if (!attempted && !capped) report('상점 구매 대기 · 선택 품목 재고 없음');
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
      await game.command('PutItemInStorage',{itemId:plan.itemKey,storageId:plan.storageId,quantity:plan.amount},next=> {
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
      (value.inventory || []).filter(i => FIELDS[i?.itemType] && itemId(i)).map(item => {
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
    shadow.querySelector('.connection').textContent=game.root?'● 연결됨':'○ 연결 대기';
    shadow.querySelector('.stop').hidden=!running;
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
      for (const [key,name,glyph] of [['buy','상점 구매','🛒'],['plant','알 심기','🥚'],['hatch','알 부화','🐣'],['sell','펫 판매','🐾'],['feed','펫 먹이','🍽️'],['settings','설정','⚙️']]) {
        const control=key==='feed'?switchFor(settings.autoFeed,setAutoFeed,'펫 먹이 자동 지급'):key==='buy' ? switchFor(settings.autoBuy,setAutoBuy,'입고 시 구매') :
          button(key==='plant'?'심기':key==='hatch'?'부화':key==='sell'?'판매':'⚙️',() => key==='plant'?void run('plant',plant):key==='hatch'?hatchAll():key==='sell'?void sell():go('settings'),'pill');
        content.append(el('div',{ class:'menu-row' },button(`${glyph}  ${name}`,()=>go(key),'menu-link'),control));
      }
      content.append(el('nav',{class:'rooms',ariaLabel:'방 이동'},...[
        ['연화','Yeonhwa'],['채리','Cherry'],['혜','Hye']
      ].map(([name,room])=>el('a',{text:name,href:`https://magicgarden.gg/r/${room.toLowerCase()}`,title:`${room} 방으로 이동`} ))));
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
    if(!game.root || game.socket?.readyState!==1)return null;
    const native=nativeGameTeams.read(game.selfId,game.root);
    if(native!==null)return native;
    return nativeTeams(mySlot(game.root,game.selfId)?.data);
  }
  async function refreshNativeTeams() {
    await nativeGameTeams.connect();
    if(view==='settings')report(syncTeamControls());
  }
  function teamOptions(key,teams) {
    const options=(teams || []).map(t=>[t.id,typeof t.name==='string' && t.name.trim()?t.name:t.id]);
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
    const text=teams===null?'게임 펫 팀 동기화 대기':`게임 펫 팀 ${teams.length}개${missing?' · 찾을 수 없는 선택이 있습니다. 팀을 다시 선택하세요.':teams.length?' · 새 팀과 이름 변경 자동 반영':' · 게임에서 팀을 저장하면 표시됩니다.'}`;
    const label=content.querySelector('.team-status');if(label)label.textContent=text;
    return text;
  }
  function renderSettings() {
    const teams=teamSnapshot();
    for (const [key,name] of [['hatch','부화 프리셋'],['sell','판매 프리셋'],['restore','종료 후 복구']]) {
      const opts=teamOptions(key,teams),node=select(settings.teams[key],opts,v=>{settings.teams[key]=v;syncTeamControls();},name);
      node.dataset.preset=key;node.dataset.options=JSON.stringify(opts);content.append(row(name,node));
    }
    content.append(el('small',{class:'team-status'}),button('팀 목록 새로고침',()=>void refreshNativeTeams()));
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
      header{padding:9px 10px 0;flex:none;cursor:move;touch-action:none;user-select:none}.brand{display:flex;align-items:center;justify-content:space-between;gap:8px}.brand strong{font-size:13px;font-weight:650;flex:1;padding:5px 0;letter-spacing:-.2px}.brand button{font-size:17px;line-height:1;width:25px;height:25px;padding:0;color:#c7cccd;cursor:pointer}.badges{display:flex;align-items:center;gap:7px;margin:6px 0 8px}.badges span{font-size:11px;border:1px solid #4b8562;background:#32544044;border-radius:5px;padding:2px 6px;color:#e0eee5}.subhead{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid #ffffff16;cursor:default}.page-name{flex:1;font-size:12px;color:#aeb8b4}.home .subhead{padding:0;border-top:0}.home .page-name{display:none}.back{font-size:11px;padding:4px 8px}.stop{font-size:11px;color:#f0c8c2;border-color:#8c635f;margin:5px 0}
      .body{padding:0 10px 9px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#ffffff28 transparent;min-height:0}.home .body{padding:4px 10px 8px;border-top:1px solid #ffffff16}.menu-row{display:flex;align-items:center;min-height:34px;gap:8px}.menu-link{flex:1;text-align:left;background:none;border:0;font-weight:500;padding:6px 0;border-radius:4px}.menu-link:hover{background:#ffffff06}.pill{font-size:12px;min-width:43px;padding:4px 7px;border:1px solid #ffffff25;background:#ffffff06}
      .row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #ffffff0d}.grow{flex:1;min-width:0}.label{font-weight:500;overflow-wrap:anywhere}small{display:block;font-size:11px;color:#97a39f;line-height:1.4;margin-top:2px}p{font-size:12px;color:#b1bab7;margin:7px 0 9px}h3{font-size:12px;color:#b7c9bf;margin:12px 0 4px;font-weight:600}h2{font-size:17px;margin-top:0}
      .rooms{display:flex;gap:6px;padding-top:8px;margin-top:5px;border-top:1px solid #ffffff16}.rooms a{flex:1;text-align:center;color:#dce6df;text-decoration:none;padding:5px 0;border:1px solid #ffffff24;border-radius:4px;background:#ffffff07}.rooms a:hover{background:#ffffff13}
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
      el('div',{class:'subhead'},button('‹ 뒤로',()=>go('home'),'back'),el('span',{class:'page-name'}),button('중지',()=>{if(running){running.cancel=true;if(running.kind==='feed')setAutoFeed(false);if(running.kind==='buy')setAutoBuy(false);save();}report('현재 요청 확인 후 중지합니다.');},'stop'))),content,footer);
    enablePanelDrag(panel.querySelector('header'));
    shadow.append(style,icon,panel);placeIcon();window.addEventListener('resize',()=>{placeIcon();placePanel();});refresh();void loadCatalog();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
