'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, BookOpen, Check, X } from 'lucide-react';
import { tourPosition } from '@/lib/tour-layout';

type Step = { target: string; title: string; body: string; tip?: string };
const SEARCH_STEPS: Step[] = [
  { target: '.origin-block', title: '选的是车站，不是城市', body: '输入站名或拼音，点选具体车站。杭州东、杭州南、杭州西是不同车站，上海虹桥、上海南也一样。和城市同名的那一项不能选。', tip: '官网只返回其他站点时，结果会给出真实站点组合；点击后重新查票。' },
  { target: '.destination-block', title: '排好你想去的到站', body: '可以添加多个备选到站。拖动左侧手柄，或点击上下箭头调整优先级；手机也能用箭头排序。', tip: '例如苍南 → 温州南 → 温州北，排在前面的站优先考虑。' },
  { target: '.date-time-row', title: '注意日期和最早出发时间', body: '默认查今天、当前时间之后的班次。晚上查询可能没有符合条件的车；可以修改时间，或选择之后的日期。', tip: '跨午夜的票段会显示各自实际乘车日期。所有时间均为北京时间。' },
  { target: '.seat-block', title: '只查你接受的车型与席别', body: 'G 是高铁，D 是动车，C 是城际。勾选商务、一等、二等或无座；两段票允许在已勾选的席别中混搭。', tip: '默认二等座。两段票可能换座，会标出接续站。' },
  { target: '.strategy-options', title: '同车分段与换车中转', body: '同车两段票在同一趟车上换座；异车中转则在同一车站下车，换乘另一趟车。展开中转条件可指定换乘站、最短等待和是否过夜等车。', tip: '买长乘短买到更远的站；短票未覆盖全程，须在原票到站前申请补票，是否获准取决于运输能力。' },
  { target: '.helper-pill', title: 'Mac 保持在线，手机就能查', body: '先启动已配对的 Mac 查询助手。这里会显示在线状态；官网要求登录或验证码时，回到电脑正常处理后继续。', tip: '离线、验证码、限流或解析失败会明确显示为未确认，不能当成无票。' },
  { target: '.search-button', title: '提交后先看已查到的结果', body: '点击查询，直达票会先显示，再逐步核验中转与同车分段。不必等全部分析结束；需要时可取消。', tip: '改变条件后要重新查询。车票库存不会因查询而保留。' },
  { target: '.result-tabs', title: '少量优选，按价格或用时比较', body: '默认展示最多 6 个方案，综合推荐将总票价和含等车的总用时各占一半。可切换价格、用时排序，或展开其余方案；各类方案也能单独查看。', tip: '推荐限于本次已核验候选，不保证查遍所有路线。票价“待确认”不是零元，不会获得较省标签。' },
  { target: '.train-map-link, .results-heading', title: '选中班次，查看乘车路线', body: '点击车次或“乘车路线”，直接查看官方经停、每张票覆盖区间和换座站。蓝色为票面覆盖，橙色虚线未覆盖，紫色为多买区间。', tip: '地理地图可一键查看全国和当前路线；站序图方便核对各段票。地图连线表示经停顺序。' },
  { target: '.plan-actions, .rules-note', title: '购票前重新核验', body: '每张票可分别打开官网，自动带入实际车站和乘车日期；进入后选择显示的车次。可先重新核验选定方案，任一段失效就不会继续显示为可买。', tip: '这里只查询和规划，不自动购票；所有候选票都尚未购买。' },
];
const MAP_STEPS: Step[] = [
  { target: '.journey-plan-switcher, .map-segmented', title: '在地图里切换班次', body: '使用方案选择框或左右箭头，直接比较不同班次和购票方案。地图保留当前窗口，平滑移动到新路线。', tip: '切换只展示本次查询已取得的数据；余票仍以各自采集时间为准。' },
  { target: '.map-segmented', title: '选择乘车范围', body: '我的乘车区间包含上车、目的地与票面到站。全部经停展示这趟列车已确认的完整停站表。', tip: '经停不完整时会明确提示，不会把区间两端当作全车停站。' },
  { target: '.map-view-switch', title: '地理地图和站序图', body: '地理地图显示车站之间的方向和位置；站序图按官方顺序展开，方便逐站核对时刻、换座和票面覆盖。', tip: '经停连线是示意，不表示实际轨道或列车位置。未确认的位置会明确提示。' },
  { target: '.national-map-controls, .journey-list-heading', title: '全国与当前路线一键切换', body: '点击全国查看中国全境，点击当前路线回到所选班次。地图可拖动、滚轮缩放，手机可用双指缩放。右下角也有全国概览。', tip: '查看其他省份的班次时使用全部经停，地图会跟随完整路线调整范围。' },
  { target: '.map-legend', title: '看清票覆盖了哪里', body: '蓝色是票面覆盖区间。橙色虚线是短票没有覆盖的后续区间；紫色是买长乘短额外购买的区间。', tip: '橙色路线不表示有票，也不保证能补票。' },
  { target: '.journey-key-jumps, .journey-list-heading', title: '点选车站，查看换座与补票', body: '通过关键站按钮，或直接点击地图上的站点，查看时刻和票段信息。接续站会提示可能换座，短票到站会标出尚未覆盖的区间。', tip: '详细席别、余票和票价可在地图下方展开；进入 12306 前可重新核验。' },
];

export default function UsageTour({ variant = 'search', onClose }: { variant?: 'search' | 'map'; onClose: () => void }) {
  const steps = variant === 'map' ? MAP_STEPS : SEARCH_STEPS;
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<{ left: number; top: number; box: DOMRect | null }>({ left: 12, top: 12, box: null });
  const panel = useRef<HTMLDivElement>(null);
  const heading = useId(), description = useId();
  const step = steps[index];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (!['Escape', 'Tab', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); setIndex(i => Math.max(0, Math.min(steps.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))); return;
      }
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])];
      if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === panel.current)) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && (document.activeElement === buttons.at(-1) || document.activeElement === panel.current)) { event.preventDefault(); buttons[0]?.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key, true); previous?.focus(); };
  }, [onClose, steps]);
  useEffect(() => {
    let frame = 0;
    const element = step.target.split(',').map(selector => document.querySelector<HTMLElement>(selector.trim())).find(target => target?.getClientRects().length);
    if (element?.getClientRects().length) element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const measure = () => {
      const visible = element && element.getClientRects().length ? element : null;
      let box = visible?.getBoundingClientRect() || null;
      const card = panel.current?.getBoundingClientRect();
      const position = tourPosition(box, { width: innerWidth, height: innerHeight }, { width: card?.width || 350, height: card?.height || 300 });
      if (visible && box && innerWidth < 760 && box.bottom > position.top - 16 && box.top < position.top + (card?.height || 300) + 16) {
        const shift = Math.min(box.bottom - position.top + 16, Math.max(0, box.top - 16));
        const scroll = visible.closest<HTMLElement>('.route-map-scroll');
        if (scroll) scroll.scrollBy({ top: shift, behavior: 'instant' });
        else window.scrollBy({ top: shift, behavior: 'instant' });
        box = visible.getBoundingClientRect();
      }
      setLayout({ ...position, box });
    };
    frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    const observer = new ResizeObserver(measure); if (panel.current) observer.observe(panel.current);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [step]);
  return createPortal(<div className="usage-tour-layer">
    <div className={`tour-screen ${layout.box ? 'has-target' : ''}`} />
    {layout.box && <div className="tour-spotlight" aria-hidden="true" style={{ left: Math.max(4, layout.box.left - 5), top: Math.max(4, layout.box.top - 5), width: Math.min(innerWidth - 8, layout.box.width + 10), height: Math.min(innerHeight - 8, layout.box.height + 10) }} />}
    <div className="tour-card" ref={panel} role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={description} tabIndex={-1} style={{ left: layout.left, top: layout.top }}>
      <div className="tour-card-top"><span><BookOpen size={16} />{variant === 'map' ? '路线教程' : '使用教程'} <b>{index + 1} / {steps.length}</b></span><button aria-label="关闭教程" onClick={onClose}><X size={18} /></button></div>
      <div className="tour-copy" aria-live="polite"><h2 id={heading}>{step.title}</h2><p id={description}>{step.body}</p>{step.tip && <p className="tour-tip">{step.tip}</p>}</div>
      <div className="tour-dots" aria-label="教程步骤">{steps.map((item, i) => <button key={item.title} className={i === index ? 'active' : ''} aria-label={`第 ${i + 1} 步：${item.title}`} aria-current={i === index ? 'step' : undefined} onClick={() => setIndex(i)} />)}</div>
      <div className="tour-actions"><button onClick={onClose} className="tour-skip">结束教程</button><button disabled={index === 0} onClick={() => setIndex(i => i - 1)}><ArrowLeft size={14} />上一步</button><button className="tour-next" onClick={() => index === steps.length - 1 ? onClose() : setIndex(i => i + 1)}>{index === steps.length - 1 ? <><Check size={15} />我知道了</> : <>下一步<ArrowRight size={14} /></>}</button></div>
    </div>
  </div>, document.body);
}
