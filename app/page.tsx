"use client";

import React, { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { AnimatePresence, motion } from "framer-motion";

const suits = ["♠", "♥", "♦", "♣"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const rankValue = Object.fromEntries(ranks.map((r, i) => [r, i + 2]));

const STARTING_STACK = 5000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

type Card = {
  rank: string;
  suit: string;
  value: number;
};

type Player = {
  id: number;
  name: string;
  stack: number;
  hand: Card[];
  folded: boolean;
  bet: number;
  lastAction: string;
  isHero: boolean;
  level: string;
  persona?: string;
};


type ChipBurst = {
  id: number;
  playerId: number;
  amount: number;
};

type RoomState = {
  code: string;
  players: { id: string; name: string }[];
};

const aiPersonas = [
  { name: "疯狗", style: "loose_aggressive" },
  { name: "老油条", style: "tricky" },
  { name: "铁乌龟", style: "tight" },
  { name: "跟注站", style: "calling_station" },
  { name: "鲨鱼", style: "shark" },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDeck() {
  const deck: Card[] = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit, value: Number(rankValue[rank]) });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function cardText(card: Card) {
  return `${card.rank}${card.suit}`;
}

function isRed(card: Card) {
  return card.suit === "♥" || card.suit === "♦";
}

function createPlayers(aiLevel: string): Player[] {
  return [
    {
      id: 0,
      name: "你",
      stack: STARTING_STACK,
      hand: [],
      folded: false,
      bet: 0,
      lastAction: "等待",
      isHero: true,
      level: "hero",
    },
    ...Array.from({ length: 5 }).map((_, i) => ({
      id: i + 1,
      name: `AI ${i + 1}｜${aiPersonas[i].name}`,
      stack: STARTING_STACK,
      hand: [],
      folded: false,
      bet: 0,
      lastAction: "等待",
      isHero: false,
      level: aiLevel,
      persona: aiPersonas[i].style,
    })),
  ];
}

function cleanPlayers(players: Player[]) {
  return players.map((p) => ({
    ...p,
    hand: [],
    folded: false,
    bet: 0,
    lastAction: "等待",
  }));
}

function getStartingHandScore(hand: Card[]) {
  if (hand.length < 2) return 0;
  const [a, b] = hand;
  const high = Math.max(a.value, b.value);
  const low = Math.min(a.value, b.value);
  const pair = a.value === b.value;
  const suited = a.suit === b.suit;
  const gap = high - low;

  let score = high * 4 + low * 2;
  if (pair) score += 45 + high * 3;
  if (suited) score += 8;
  if (gap === 1) score += 6;
  if (gap === 2) score += 3;
  if (gap >= 5) score -= 8;
  if (high === 14) score += 10;
  if (high >= 12 && low >= 10) score += 12;
  return score;
}

function combinations<T>(arr: T[], k: number) {
  const result: T[][] = [];
  function backtrack(start: number, combo: T[]) {
    if (combo.length === k) {
      result.push(combo);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      backtrack(i + 1, [...combo, arr[i]]);
    }
  }
  backtrack(0, []);
  return result;
}

function evaluateFive(cards: Card[]) {
  const values = cards.map((c) => c.value).sort((a, b) => b - a);
  const counts: Record<number, number> = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;

  const unique = [...new Set(values)].sort((a, b) => b - a);
  const wheel = unique.includes(14) && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2);
  let straightHigh = wheel ? 5 : 0;
  for (let i = 0; i <= unique.length - 5; i++) {
    const slice = unique.slice(i, i + 5);
    if (slice[0] - slice[4] === 4) straightHigh = Math.max(straightHigh, slice[0]);
  }

  const flush = cards.every((c) => c.suit === cards[0].suit);
  const groups = Object.entries(counts)
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0].count === 4) return [7, groups[0].value, ...unique.filter((v) => v !== groups[0].value)];
  if (groups[0].count === 3 && groups[1]?.count === 2) return [6, groups[0].value, groups[1].value];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0].count === 3) return [3, groups[0].value, ...unique.filter((v) => v !== groups[0].value)];
  if (groups[0].count === 2 && groups[1]?.count === 2) {
    const pairs = groups.filter((g) => g.count === 2).map((g) => g.value).sort((a, b) => b - a);
    const kicker = unique.find((v) => !pairs.includes(v)) || 0;
    return [2, ...pairs, kicker];
  }
  if (groups[0].count === 2) return [1, groups[0].value, ...unique.filter((v) => v !== groups[0].value)];
  return [0, ...values];
}

function compareScore(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHandScore(cards: Card[]) {
  if (cards.length < 5) return [0, ...cards.map((c) => c.value).sort((a, b) => b - a)];
  return combinations(cards, 5).map(evaluateFive).sort((a, b) => compareScore(b, a))[0];
}

function handName(score: number[]) {
  return ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"][score?.[0] || 0];
}

function estimateStrength(hand: Card[], board: Card[] = []) {
  const start = getStartingHandScore(hand);
  if (board.length === 0) return Math.min(95, Math.max(5, Math.round(start)));
  const score = bestHandScore([...hand, ...board]);
  let base = [18, 35, 52, 68, 76, 82, 90, 96, 99][score[0]];
  const highCards = hand.filter((c) => c.value >= 12).length;
  const drawBonus = board.length < 5 && hand.some((c) => c.value >= 12) ? 4 : 0;
  base += highCards * 3 + drawBonus;
  return Math.min(99, Math.max(3, base));
}

function personaConfig(persona?: string, level = "normal") {
  const hard = level === "hard";
  const base = {
    tightness: 42,
    aggression: 0.12,
    bluff: 0.07,
    randomness: hard ? 26 : 14,
    callBias: 0,
  };

  if (persona === "loose_aggressive") return { ...base, tightness: hard ? 24 : 32, aggression: hard ? 0.48 : 0.28, bluff: hard ? 0.35 : 0.16, randomness: hard ? 46 : 22 };
  if (persona === "tricky") return { ...base, tightness: hard ? 32 : 38, aggression: hard ? 0.38 : 0.18, bluff: hard ? 0.3 : 0.14, randomness: hard ? 42 : 20 };
  if (persona === "tight") return { ...base, tightness: hard ? 50 : 58, aggression: hard ? 0.22 : 0.1, bluff: hard ? 0.12 : 0.03, randomness: hard ? 24 : 12 };
  if (persona === "calling_station") return { ...base, tightness: hard ? 28 : 34, aggression: hard ? 0.14 : 0.05, bluff: hard ? 0.08 : 0.02, randomness: hard ? 30 : 16, callBias: hard ? 18 : 10 };
  if (persona === "shark") return { ...base, tightness: hard ? 34 : 40, aggression: hard ? 0.42 : 0.22, bluff: hard ? 0.22 : 0.1, randomness: hard ? 32 : 16 };
  return base;
}

function gtoAdvice(hand: Card[], board: Card[], toCall: number, pot: number, heroStack: number) {
  const strength = estimateStrength(hand, board);
  const potOdds = toCall > 0 ? Math.round((toCall / (pot + toCall)) * 100) : 0;
  let action = "弃牌";
  let reason = "牌力偏弱，面对下注不适合投入太多筹码。";

  if (toCall === 0) {
    if (strength >= 72) {
      action = "下注 50%-75% 底池";
      reason = "牌力强，可以价值下注，也能保护牌面。";
    } else if (strength >= 48) {
      action = "过牌 / 小注";
      reason = "中等牌力，适合控制底池。";
    } else {
      action = "过牌";
      reason = "弱牌优先免费看下一张。";
    }
  } else if (strength >= 70) {
    action = "加注 / 跟注";
    reason = "牌力足够强，可以继续打价值。";
  } else if (strength >= potOdds + 18) {
    action = "跟注";
    reason = "估算胜率高于底池赔率。";
  }

  if (heroStack <= BIG_BLIND * 6 && strength >= 55) {
    action = "全下";
    reason = "短码状态下，中强牌可以直接推入。";
  }

  return { strength, potOdds, action, reason };
}

function ChipStack({ amount, small = false }: { amount: number; small?: boolean }) {
  if (amount <= 0) return null;
  const chips = Math.min(9, Math.ceil(amount / 80));
  return (
    <div className="flex items-end gap-1 h-9 mt-2">
      {Array.from({ length: chips }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className={`${small ? "w-5 h-2" : "w-7 h-3"} rounded-full border border-white/50 bg-red-500 shadow`}
          style={{ marginBottom: i * 2 }}
        />
      ))}
      <span className="text-xs text-amber-200 font-black">{amount}</span>
    </div>
  );
}

function CardView({ card, hidden = false }: { card?: Card; hidden?: boolean }) {
  if (hidden || !card) {
    return (
      <div className="w-12 h-16 md:w-14 md:h-20 rounded-xl bg-indigo-700 border border-indigo-400 shadow flex items-center justify-center text-xl">
        ★
      </div>
    );
  }

  return (
    <motion.div
      initial={{ rotateY: 90, y: 10, opacity: 0 }}
      animate={{ rotateY: 0, y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 260, damping: 18 }}
      className="w-12 h-16 md:w-14 md:h-20 rounded-xl bg-white text-black shadow flex flex-col items-center justify-center font-black"
    >
      <span className={isRed(card) ? "text-red-600" : "text-black"}>{card.rank}</span>
      <span className={isRed(card) ? "text-red-600" : "text-black"}>{card.suit}</span>
    </motion.div>
  );
}

export default function PokerTrainer() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [onlineMessage, setOnlineMessage] = useState("未连接房间");
  const [aiLevel, setAiLevel] = useState("hard");
  const [players, setPlayers] = useState<Player[]>(() => createPlayers("hard"));
  const [deck, setDeck] = useState<Card[]>([]);
  const [board, setBoard] = useState<Card[]>([]);
  const [pot, setPot] = useState(0);
  const [currentBet, setCurrentBet] = useState(0);
  const [street, setStreet] = useState("准备");
  const [message, setMessage] = useState("点击开始新一手。目标：打光5个困难AI的筹码。");
  const [showGto, setShowGto] = useState(false);
  const [showAiCards, setShowAiCards] = useState(false);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [handOver, setHandOver] = useState(true);
  const [actingPlayerId, setActingPlayerId] = useState<number | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [chipBursts, setChipBursts] = useState<ChipBurst[]>([]);

  const hero = players[0];
  const toCall = Math.max(0, currentBet - hero.bet);
  const advice = useMemo(() => gtoAdvice(hero.hand, board, toCall, pot, hero.stack), [hero.hand, board, toCall, pot, hero.stack]);
  const aiAlive = players.filter((p) => !p.isHero && p.stack > 0).length;

  useEffect(() => {
    const nextSocket = io();
    setSocket(nextSocket);

    nextSocket.on("connect", () => {
      setOnlineMessage("已连接服务器，可以创建或加入房间。");
    });

    nextSocket.on("roomUpdate", (nextRoom: RoomState) => {
      setRoom(nextRoom);
      setOnlineMessage(`房间 ${nextRoom.code}：${nextRoom.players.length}/2 人已加入`);
    });

    nextSocket.on("errorMessage", (msg: string) => {
      setOnlineMessage(msg);
    });

    nextSocket.on("disconnect", () => {
      setOnlineMessage("已断开服务器连接。");
    });

    return () => {
      nextSocket.disconnect();
    };
  }, []);

  function createOnlineRoom() {
    socket?.emit("createRoom");
  }

  function joinOnlineRoom() {
    const code = roomCodeInput.trim().toUpperCase();
    if (!code) {
      setOnlineMessage("请输入房间号。");
      return;
    }
    socket?.emit("joinRoom", code);
  }

  function addChipBurst(playerId: number, amount: number) {
    if (amount <= 0) return;
    const id = Date.now() + Math.random();
    setChipBursts((items) => [...items, { id, playerId, amount }]);
    setTimeout(() => setChipBursts((items) => items.filter((item) => item.id !== id)), 950);
  }

  function resetGame(level = aiLevel) {
    setAiLevel(level);
    setPlayers(createPlayers(level));
    setDeck([]);
    setBoard([]);
    setPot(0);
    setCurrentBet(0);
    setStreet("准备");
    setMessage("已重新开始。点击开始新一手。目标：打光5个困难AI的筹码。");
    setShowAiCards(false);
    setActionLog([]);
    setHandOver(true);
    setActingPlayerId(null);
    setIsResolving(false);
    setChipBursts([]);
  }

  function startHand() {
    const activePlayers = players.filter((p) => p.stack > 0);
    if (hero.stack <= 0) return resetGame(aiLevel);
    if (activePlayers.filter((p) => !p.isHero).length === 0) {
      setMessage("你已经打光所有AI，训练完成！可以重新开始。");
      setHandOver(true);
      return;
    }

    const newDeck = makeDeck();
    let newPlayers = cleanPlayers(players).filter((p) => p.stack > 0);
    if (!newPlayers.some((p) => p.isHero)) newPlayers = createPlayers(aiLevel);

    for (let round = 0; round < 2; round++) {
      newPlayers = newPlayers.map((p) => ({ ...p, hand: [...p.hand, newDeck.pop() as Card] }));
    }

    let newPot = 0;
    const log: string[] = [];
    newPlayers = newPlayers.map((p, i) => {
      const blind = i === 1 ? SMALL_BLIND : i === 2 ? BIG_BLIND : 0;
      const pay = Math.min(blind, p.stack);
      newPot += pay;
      if (pay > 0) {
        log.push(`${p.name} 下盲注 ${pay}`);
        addChipBurst(p.id, pay);
      }
      return { ...p, stack: p.stack - pay, bet: pay, lastAction: pay > 0 ? `盲注 ${pay}` : "等待" };
    });

    setPlayers(newPlayers);
    setDeck(newDeck);
    setBoard([]);
    setPot(newPot);
    setCurrentBet(BIG_BLIND);
    setStreet("翻牌前");
    setMessage("新一手开始。你行动。每次你操作后，AI会按顺序思考和下注。");
    setShowAiCards(false);
    setActionLog(["新一手开始", ...log]);
    setActingPlayerId(0);
    setIsResolving(false);
    setHandOver(false);
  }

  async function updateHero(action: string, amount = 0) {
    if (handOver || isResolving) return;
    setIsResolving(true);

    let newPlayers = [...players];
    let newPot = pot;
    let newBet = currentBet;
    const h = { ...newPlayers[0] };

    if (action === "fold") {
      h.folded = true;
      h.lastAction = "弃牌";
      newPlayers[0] = h;
      setPlayers(newPlayers);
      setActionLog((log) => ["你弃牌", ...log]);
      setShowAiCards(true);
      setMessage("你弃牌了。本手结束，AI拿走底池。");
      givePotToAi(newPlayers, newPot);
      return;
    }

    if (action === "call") {
      const pay = Math.min(toCall, h.stack);
      h.stack -= pay;
      h.bet += pay;
      h.lastAction = toCall > 0 ? `跟注 ${pay}` : "过牌";
      newPot += pay;
      addChipBurst(0, pay);
      setActionLog((log) => [`你${toCall > 0 ? `跟注 ${pay}` : "过牌"}`, ...log]);
    }

    if (action === "raise") {
      const target = currentBet + amount;
      const pay = Math.min(target - h.bet, h.stack);
      h.stack -= pay;
      h.bet += pay;
      h.lastAction = `加注到 ${h.bet}`;
      newPot += pay;
      newBet = Math.max(newBet, h.bet);
      addChipBurst(0, pay);
      setActionLog((log) => [`你加注到 ${h.bet}`, ...log]);
    }

    if (action === "allin") {
      const pay = h.stack;
      h.stack = 0;
      h.bet += pay;
      h.lastAction = `全下 ${h.bet}`;
      newPot += pay;
      newBet = Math.max(newBet, h.bet);
      addChipBurst(0, pay);
      setActionLog((log) => [`你全下，总下注 ${h.bet}`, ...log]);
    }

    newPlayers[0] = h;
    setPlayers(newPlayers);
    setPot(newPot);
    setCurrentBet(newBet);
    await sleep(500);
    await aiActSequential(newPlayers, newPot, newBet);
  }

  async function aiActSequential(basePlayers: Player[], basePot: number, baseBet: number) {
    let newPlayers = [...basePlayers];
    let newPot = basePot;
    let newBet = baseBet;

    for (let idx = 1; idx < newPlayers.length; idx++) {
      const p = newPlayers[idx];
      if (p.folded || p.stack <= 0) continue;

      setActingPlayerId(p.id);
      setMessage(`${p.name} 正在思考...`);
      await sleep(p.level === "hard" ? 650 + Math.random() * 900 : 450 + Math.random() * 500);

      const callNeed = Math.max(0, newBet - p.bet);
      const strength = estimateStrength(p.hand, board);
      const cfg = personaConfig(p.persona, p.level);
      const levelBonus = p.level === "easy" ? -10 : p.level === "hard" ? 12 : 0;
      const randomSwing = Math.random() * cfg.randomness - cfg.randomness / 2;
      const adjusted = strength + levelBonus + cfg.callBias + randomSwing;
      const updated = { ...p };
      let logText = "";

      if (callNeed > 0 && adjusted < cfg.tightness && Math.random() > cfg.bluff) {
        updated.folded = true;
        updated.lastAction = "弃牌";
        logText = `${updated.name} 弃牌`;
      } else {
        const shouldAllIn = p.level === "hard" && updated.stack > callNeed && Math.random() < 0.08 && (strength > 62 || Math.random() < 0.35);
        if (shouldAllIn) {
          const pay = updated.stack;
          updated.stack = 0;
          updated.bet += pay;
          updated.lastAction = `突然全下 ${updated.bet}`;
          newPot += pay;
          newBet = Math.max(newBet, updated.bet);
          addChipBurst(updated.id, pay);
          logText = `${updated.name} 突然全下，总下注 ${updated.bet}`;
        } else {
          const wantsRaise = updated.stack > callNeed + BIG_BLIND * 2 && (adjusted > 70 || Math.random() < cfg.aggression || Math.random() < cfg.bluff);
          if (wantsRaise) {
            const maxUnits = p.level === "hard" ? 8 : 3;
            const raiseSize = BIG_BLIND * (2 + Math.floor(Math.random() * maxUnits));
            const raiseTo = newBet + raiseSize;
            const pay = Math.min(raiseTo - updated.bet, updated.stack);
            updated.stack -= pay;
            updated.bet += pay;
            updated.lastAction = strength < 45 ? `诈唬加注到 ${updated.bet}` : `加注到 ${updated.bet}`;
            newPot += pay;
            newBet = Math.max(newBet, updated.bet);
            addChipBurst(updated.id, pay);
            logText = `${updated.name} ${updated.lastAction}`;
          } else {
            const pay = Math.min(callNeed, updated.stack);
            updated.stack -= pay;
            updated.bet += pay;
            updated.lastAction = callNeed > 0 ? `跟注 ${pay}` : "过牌";
            newPot += pay;
            addChipBurst(updated.id, pay);
            logText = `${updated.name} ${updated.lastAction}`;
          }
        }
      }

      newPlayers[idx] = updated;
      setPlayers([...newPlayers]);
      setPot(newPot);
      setCurrentBet(newBet);
      setActionLog((log) => [logText, ...log]);
      setMessage(logText);
      await sleep(500);

      const active = newPlayers.filter((player) => !player.folded && player.stack >= 0);
      if (active.length <= 1) {
        const winner = active[0];
        newPlayers = newPlayers.map((player) => (player.id === winner.id ? { ...player, stack: player.stack + newPot } : player));
        setPlayers(newPlayers);
        setPot(0);
        setShowAiCards(true);
        setHandOver(true);
        setActingPlayerId(null);
        setIsResolving(false);
        setActionLog((log) => [`${winner.name} 赢下底池 ${newPot}`, ...log]);
        setMessage(`${winner.name} 赢下底池。点击下一手。`);
        return;
      }
    }

    setPlayers(newPlayers);
    setPot(newPot);
    setCurrentBet(newBet);

    const heroAfterAi = newPlayers[0];
    const heroNeedsToRespond = !heroAfterAi.folded && heroAfterAi.stack > 0 && newBet > heroAfterAi.bet;

    if (heroNeedsToRespond) {
      setActingPlayerId(0);
      setIsResolving(false);
      setMessage(`AI加注到 ${newBet}，现在轮到你。需要跟注 ${newBet - heroAfterAi.bet}。`);
      setActionLog((log) => [`行动回到你：需要跟注 ${newBet - heroAfterAi.bet}`, ...log]);
      return;
    }

    setActingPlayerId(null);
    await sleep(450);
    advanceStreet(newPlayers, newPot);
    setIsResolving(false);
  }

  function advanceStreet(newPlayers: Player[], newPot: number) {
    let newDeck = [...deck];
    let newBoard = [...board];
    let nextStreet = street;

    if (street === "翻牌前") {
      newBoard = [newDeck.pop() as Card, newDeck.pop() as Card, newDeck.pop() as Card];
      nextStreet = "翻牌";
    } else if (street === "翻牌") {
      newBoard = [...newBoard, newDeck.pop() as Card];
      nextStreet = "转牌";
    } else if (street === "转牌") {
      newBoard = [...newBoard, newDeck.pop() as Card];
      nextStreet = "河牌";
    } else {
      showdown(newPlayers, newBoard, newPot);
      return;
    }

    const clearedPlayers = newPlayers.map((p) => ({ ...p, bet: 0, lastAction: p.folded ? "已弃牌" : "等待" }));
    setPlayers(clearedPlayers);
    setDeck(newDeck);
    setBoard(newBoard);
    setCurrentBet(0);
    setStreet(nextStreet);
    setActingPlayerId(0);
    setActionLog((log) => [`发出${nextStreet}：${newBoard.map(cardText).join(" ")}`, ...log]);
    setMessage(`${nextStreet}圈。你行动。`);
  }

  function showdown(finalPlayers = players, finalBoard = board, finalPot = pot) {
    const contenders = finalPlayers.filter((p) => !p.folded);
    const ranked = contenders.map((p) => ({ ...p, score: bestHandScore([...p.hand, ...finalBoard]) }));
    ranked.sort((a, b) => compareScore(b.score, a.score));
    const winner = ranked[0];
    const newPlayers = finalPlayers.map((p) => (p.id === winner.id ? { ...p, stack: p.stack + finalPot } : p));
    setPlayers(newPlayers);
    setPot(0);
    setShowAiCards(true);
    setHandOver(true);
    setActingPlayerId(null);
    setIsResolving(false);
    setActionLog((log) => [`摊牌：${winner.name} 用 ${handName(winner.score)} 赢下 ${finalPot}`, ...log]);
    setMessage(`${winner.name} 摊牌获胜：${handName(winner.score)}。点击下一手继续。`);
  }

  function givePotToAi(newPlayers: Player[], newPot: number) {
    const aiWinner = newPlayers.find((p) => !p.isHero && !p.folded) || newPlayers.find((p) => !p.isHero);
    if (!aiWinner) return;
    const paid = newPlayers.map((p) => (p.id === aiWinner.id ? { ...p, stack: p.stack + newPot } : p));
    setPlayers(paid);
    setPot(0);
    setShowAiCards(true);
    setHandOver(true);
    setActingPlayerId(null);
    setIsResolving(false);
    setActionLog((log) => [`${aiWinner.name} 获得底池 ${newPot}`, ...log]);
  }

  function PlayerSeat({ p }: { p: Player }) {
    const isActing = actingPlayerId === p.id;
    return (
      <motion.div
        animate={{ scale: isActing ? 1.05 : 1, y: isActing ? -6 : 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className={`relative rounded-2xl p-3 bg-emerald-950/80 border ${
          isActing
            ? "border-yellow-300 shadow-[0_0_25px_rgba(250,204,21,0.55)]"
            : p.folded
              ? "opacity-40 border-red-500"
              : "border-emerald-600"
        }`}
      >
        <div className="font-bold">{p.name}</div>
        <div className="text-sm text-emerald-200">筹码：{p.stack}</div>
        <div className="text-sm text-amber-200 font-bold">当前下注：{p.bet}</div>
        <div className="text-xs text-sky-200">上次行动：{p.lastAction}</div>
        <div className="text-xs text-emerald-300">{p.folded ? "已弃牌" : p.stack <= 0 ? "全下" : "游戏中"}</div>
        <div className="flex gap-1 mt-2">
          {p.hand.length ? (
            p.hand.map((c, i) => <CardView key={i} card={c} hidden={!showAiCards && !handOver} />)
          ) : (
            <>
              <CardView hidden />
              <CardView hidden />
            </>
          )}
        </div>
        <ChipStack amount={p.bet} small />
        <AnimatePresence>
          {chipBursts.filter((burst) => burst.playerId === p.id).map((burst) => (
            <motion.div
              key={burst.id}
              initial={{ y: -10, opacity: 0, scale: 0.6 }}
              animate={{ y: 50, opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-amber-400 text-black px-2 py-1 text-xs font-black shadow-lg"
            >
              +{burst.amount}
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    );
  }

  return (
    <main className="min-h-screen bg-emerald-950 text-white p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-black">Texas Hold'em AI 训练桌</h1>
            <p className="text-emerald-200">顺序行动｜筹码动画｜GTO辅助｜AI牌手性格｜2人联机测试</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => resetGame("hard")}
              className="rounded-xl bg-white px-4 py-2 font-bold text-emerald-950"
            >
              困难AI
            </button>
          </div>
        </header>

        <section className="rounded-2xl bg-neutral-950 border border-emerald-700 p-4 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <div className="text-xl font-black">2人联机房间</div>
              <div className="text-sm text-emerald-200">{onlineMessage}</div>
              {room && (
                <div className="text-sm text-yellow-300 mt-1">
                  房间号：<span className="font-black tracking-widest">{room.code}</span> ｜ 玩家：{room.players.map((p) => p.name).join(" / ")}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={createOnlineRoom} className="rounded-xl bg-sky-500 px-4 py-2 font-bold">
                创建房间
              </button>
              <input
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="输入房间号"
                className="rounded-xl bg-neutral-900 border border-neutral-700 px-4 py-2 text-white uppercase w-32"
              />
              <button onClick={joinOnlineRoom} className="rounded-xl bg-indigo-500 px-4 py-2 font-bold">
                加入房间
              </button>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-2xl bg-emerald-900/70 border border-emerald-700 p-4">
            <div className="text-emerald-200">底池</div>
            <motion.div key={pot} initial={{ scale: 1.15 }} animate={{ scale: 1 }} className="text-4xl font-black">
              {pot}
            </motion.div>
            <ChipStack amount={pot} />
          </div>
          <div className="rounded-2xl bg-emerald-900/70 border border-emerald-700 p-4">
            <div className="text-emerald-200">阶段</div>
            <div className="text-4xl font-black">{street}</div>
          </div>
          <div className="rounded-2xl bg-emerald-900/70 border border-emerald-700 p-4">
            <div className="text-emerald-200">剩余AI</div>
            <div className="text-4xl font-black">{aiAlive}/5</div>
          </div>
        </section>

        <section className="rounded-[2rem] bg-green-800 border-4 border-amber-900 shadow-2xl p-4 md:p-8 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {players.slice(1).map((p) => <PlayerSeat key={p.id} p={p} />)}
          </div>

          <div className="text-center space-y-3">
            <div className="text-emerald-100 font-bold">公共牌</div>
            <div className="flex justify-center gap-2 min-h-20">
              {board.length ? (
                board.map((c, i) => <CardView key={`${street}-${i}-${cardText(c)}`} card={c} />)
              ) : (
                <div className="text-emerald-200">还没有公共牌</div>
              )}
            </div>
          </div>

          <motion.div
            animate={{ scale: actingPlayerId === 0 ? 1.015 : 1 }}
            className={`relative rounded-2xl bg-emerald-950/80 border p-4 space-y-3 ${
              actingPlayerId === 0 ? "border-yellow-300 shadow-[0_0_25px_rgba(250,204,21,0.45)]" : "border-emerald-600"
            }`}
          >
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <div className="text-xl font-black">你的手牌</div>
                <div className="text-emerald-200">筹码：{hero.stack}｜需跟注：{toCall}</div>
                <div className="text-xs text-sky-200">上次行动：{hero.lastAction}</div>
              </div>
              <div className="flex gap-2">
                {hero.hand.length ? hero.hand.map((c, i) => <CardView key={i} card={c} />) : <div className="text-emerald-200">点击开始新一手</div>}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {handOver ? (
                <button onClick={startHand} className="rounded-xl bg-white text-emerald-950 px-5 py-3 font-black">
                  开始/下一手
                </button>
              ) : (
                <>
                  <button disabled={isResolving} onClick={() => updateHero("fold")} className="rounded-xl bg-red-600 px-5 py-3 font-black disabled:opacity-40">
                    弃牌
                  </button>
                  <button disabled={isResolving} onClick={() => updateHero("call")} className="rounded-xl bg-white text-emerald-950 px-5 py-3 font-black disabled:opacity-40">
                    {toCall > 0 ? `跟注 ${toCall}` : "过牌"}
                  </button>
                  <button disabled={isResolving} onClick={() => updateHero("raise", BIG_BLIND * 2)} className="rounded-xl bg-amber-400 text-black px-5 py-3 font-black disabled:opacity-40">
                    加注 +40
                  </button>
                  <button disabled={isResolving} onClick={() => updateHero("raise", BIG_BLIND * 5)} className="rounded-xl bg-orange-500 text-black px-5 py-3 font-black disabled:opacity-40">
                    大加注 +100
                  </button>
                  <button disabled={isResolving} onClick={() => updateHero("allin")} className="rounded-xl bg-purple-500 px-5 py-3 font-black disabled:opacity-40">
                    全下
                  </button>
                </>
              )}
              <button onClick={() => setShowGto((s) => !s)} className="rounded-xl bg-sky-500 px-5 py-3 font-black">
                {showGto ? "关闭GTO辅助" : "打开GTO辅助"}
              </button>
              <button onClick={() => setShowAiCards((s) => !s)} className="rounded-xl bg-indigo-500 px-5 py-3 font-black">
                {showAiCards ? "隐藏AI手牌" : "显示AI手牌"}
              </button>
              <button onClick={() => resetGame(aiLevel)} className="rounded-xl bg-emerald-700 px-5 py-3 font-black">
                重新开始
              </button>
            </div>

            <ChipStack amount={hero.bet} />
            <AnimatePresence>
              {chipBursts.filter((burst) => burst.playerId === 0).map((burst) => (
                <motion.div
                  key={burst.id}
                  initial={{ y: -10, opacity: 0, scale: 0.6 }}
                  animate={{ y: -50, opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute right-6 top-10 rounded-full bg-amber-400 text-black px-2 py-1 text-xs font-black shadow-lg"
                >
                  +{burst.amount}
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        </section>

        <section className="rounded-2xl bg-neutral-950 border border-neutral-800 p-4">
          <div className="font-bold text-lg">提示</div>
          <div className="text-neutral-300">{message}</div>
          {isResolving && <div className="mt-2 text-yellow-300 animate-pulse">AI正在按顺序行动中...</div>}
        </section>

        <section className="rounded-2xl bg-neutral-950 border border-neutral-800 p-4">
          <div className="font-bold text-lg mb-2">行动记录 / 下注记录</div>
          {actionLog.length ? (
            <div className="space-y-1 max-h-56 overflow-auto text-sm text-neutral-300">
              {actionLog.map((item, i) => (
                <div key={i} className="border-b border-neutral-800 pb-1">
                  {item}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-neutral-500">还没有行动记录。</div>
          )}
        </section>

        {showGto && (
          <section className="rounded-2xl bg-sky-950 border border-sky-600 p-5 space-y-2">
            <h2 className="text-2xl font-black">GTO辅助 / 近似训练建议</h2>
            <div>
              估算牌力：<span className="font-black">{advice.strength}%</span>
            </div>
            <div>
              底池赔率：<span className="font-black">{advice.potOdds}%</span>
            </div>
            <div>
              建议操作：<span className="font-black text-amber-300">{advice.action}</span>
            </div>
            <div className="text-sky-100">原因：{advice.reason}</div>
            <div className="text-xs text-sky-300 pt-2">注意：这是轻量训练算法，不是真正PioSolver/GTO Wizard级别的完整求解器。</div>
          </section>
        )}
      </div>
    </main>
  );
}