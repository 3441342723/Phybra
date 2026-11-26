import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { baseScene, COLLISION_EXAMPLES, ELECTROMAGNETIC_EXAMPLES, EXAMPLES, inclineExample } from './model/factory';
import { getAt } from './model/paths';
import { solve } from './solver';
import { activeSolution, initStore, reducer, type Store } from './state/store';
import { exportScene, loadCamera, loadPlaybackRate, loadScene, loadSnap, readSceneFile, saveCamera, savePlaybackRate, saveScene, saveSnap } from './state/persist';
import { defaultLayout, fitPlaybackCamera, loadLayout, NARROW_WIDTH, saveLayout, workspaceLayout, WINDOW_IDS, type WindowId, type WindowLayout } from './state/layout';
import { withField, type FieldEdit } from './state/editing';
import { Canvas, type Edit } from './ui/Canvas';
import { ObjectList } from './ui/ObjectList';
import { Properties } from './ui/Properties';
import { Timeline } from './ui/Timeline';
import { Charts } from './ui/Charts';
import { ResultPanel } from './ui/ResultPanel';
import { AiPanel } from './ui/AiPanel';
import { FloatingWindow } from './ui/FloatingWindow';
import { Toolbar } from './ui/Toolbar';

export default function App() {
  const [store, dispatch] = useReducer(reducer, undefined, () => initStore(loadScene() ?? inclineExample(), loadCamera() ?? undefined, loadSnap() ?? undefined, loadPlaybackRate()));
  const storeRef = useRef<Store>(store);
  storeRef.current = store;
  const [layout, setLayout] = useState<WindowLayout>(() => loadLayout() ?? defaultLayout(Math.max(1024, window.innerWidth), Math.max(600, window.innerHeight - 180)));
  const [workspaceSize, setWorkspaceSize] = useState({ width: window.innerWidth, height: window.innerHeight - 180 });
  const [drawer, setDrawer] = useState<WindowId | null>(null);
  const narrow = workspaceSize.width <= NARROW_WIDTH;
  const viewLayout = workspaceLayout(layout, workspaceSize.width, workspaceSize.height, drawer);
  const workspaceRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [store.confirmDelete]);

  function openWindow(id: WindowId) {
    if (narrow) {
      setDrawer(id);
      return;
    }
    setLayout((prev) => ({
      ...prev,
      open: { ...prev.open, [id]: true },
      z: { ...prev.z, [id]: Math.max(...Object.values(prev.z)) + 1 },
    }));
  }

  function closeWindow(id: WindowId) {
    if (id === 'ai') dispatch({ type: 'setDraft', draft: null });
    if (narrow) {
      setDrawer(null);
      return;
    }
    setLayout((prev) => ({ ...prev, open: { ...prev.open, [id]: false } }));
  }

  function changeWindow(id: WindowId, rect: WindowLayout['rects'][WindowId]) {
    setLayout((prev) => ({ ...prev, rects: { ...prev.rects, [id]: rect } }));
  }

  function resetWindows() {
    if (narrow) {
      setDrawer(null);
      return;
    }
    const rect = workspaceRef.current?.getBoundingClientRect();
    setLayout(defaultLayout(rect?.width ?? window.innerWidth, rect?.height ?? window.innerHeight - 180));
  }

  const edit = useMemo<Edit>(() => ({
    begin() {
      if (!storeRef.current.gestureBase) dispatch({ type: 'beginGesture' });
    },
    transient(scene) {
      dispatch({ type: 'transient', scene });
    },
    end() {
      dispatch({ type: 'endGesture' });
    },
    apply(scene) {
      dispatch({ type: 'apply', scene });
    },
  }), []);

  const fields = useMemo<FieldEdit>(() => ({
    commit(path, value) {
      const st = storeRef.current;
      const next = withField(st.present, path, value);
      if (st.gestureBase) {
        dispatch({ type: 'transient', scene: next });
        dispatch({ type: 'endGesture' });
      } else {
        dispatch({ type: 'apply', scene: next });
      }
    },
    transient(path, value) {
      edit.begin();
      dispatch({ type: 'transient', scene: withField(storeRef.current.present, path, value) });
    },
  }), [edit]);

  const solution = activeSolution(store);

  // 实时预览：本地求解器，节流 120ms，绝不触发 AI
  useEffect(() => {
    const scene = store.present;
    const timer = setTimeout(() => {
      const r = solve(scene);
      dispatch({ type: 'previewResult', rev: scene.rev, result: r.ok ? { solution: r.solution, report: null } : { solution: null, report: r.report } });
    }, 120);
    return () => clearTimeout(timer);
  }, [store.present]);

  useEffect(() => {
    const timer = setTimeout(() => saveScene(store.present), 300);
    return () => clearTimeout(timer);
  }, [store.present]);

  useEffect(() => {
    saveCamera(store.camera);
  }, [store.camera]);

  useEffect(() => {
    saveSnap(store.snap);
  }, [store.snap]);

  useEffect(() => {
    savePlaybackRate(store.playbackRate);
  }, [store.playbackRate]);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  useEffect(() => {
    if (!store.notice) return;
    const timer = setTimeout(() => dispatch({ type: 'notice', text: null }), 3200);
    return () => clearTimeout(timer);
  }, [store.notice]);

  useEffect(() => {
    if (!workspaceRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      setWorkspaceSize({ width, height });
    });
    observer.observe(workspaceRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (store.playback.mode !== 'playing') return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const st = storeRef.current;
      const sol = activeSolution(st);
      if (!sol) {
        dispatch({ type: 'pause' });
        return;
      }
      const dt = (now - last) / 1000;
      last = now;
      dispatch({ type: 'tick', elapsed: dt, tEnd: sol.tEnd });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [store.playback.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo' });
      } else if (e.key === 'Delete' && !typing && storeRef.current.selection) {
        dispatch({ type: 'confirmDelete', id: storeRef.current.selection });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function startPlayback() {
    const st = storeRef.current;
    const sol = activeSolution(st);
    if (!sol) return;
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (rect) {
      const camera = fitPlaybackCamera(st.camera, sol.bodyTracks?.flatMap(track=>track.samples)??sol.samples,
        workspaceLayout(layout, rect.width, rect.height, null), rect.width, rect.height);
      if (camera !== st.camera) dispatch({ type: 'camera', camera });
    }
    if (st.playback.t >= sol.tEnd) dispatch({ type: 'scrub', t: 0 });
    dispatch({ type: 'play' });
  }

  function solveNow() {
    const r = solve(storeRef.current.present);
    dispatch({ type: 'formalResult', rev: storeRef.current.present.rev, result: r.ok ? { solution: r.solution, report: null } : { solution: null, report: r.report } });
    dispatch({ type: 'resetPlayback' });
    openWindow('result');
  }

  const deleteInfo = useMemo(() => {
    const id = store.confirmDelete;
    if (!id) return null;
    const scene = store.present;
    const sup = scene.supports.find((s) => s.id === id);
    const body = scene.bodies.find((b) => b.id === id);
    const field = scene.fields?.find(f=>f.id===id);
    const link = scene.links?.find(l=>l.id===id);
    if (!sup && !body && !field && !link) return null;
    const bodyIds = sup ? scene.bodies.filter((b) => b.attach?.support === id).map((b) => b.id) : body ? [id] : [];
    const supportIds = sup ? [id] : [];
    const contactIds = scene.contacts.filter((c) => bodyIds.includes(c.body) || supportIds.includes(c.support)).map((c) => c.id);
    const selfBody = body ? id : null;
    const dependentBodies = bodyIds.filter((b) => b !== selfBody);
    return { id, bodyIds, supportIds, contactIds, dependentBodies, field, link };
  }, [store.confirmDelete, store.present]);

  function confirmDelete() {
    if (!deleteInfo) return;
    const scene = store.present;
    const isRemoved = (path: string) =>
      deleteInfo.bodyIds.some((id) => path.startsWith(`bodies.${id}.`)) ||
      deleteInfo.supportIds.some((id) => path.startsWith(`supports.${id}.`)) ||
      (deleteInfo.field && path.startsWith(`fields.${deleteInfo.field.id}.`)) ||
      (deleteInfo.link && path.startsWith(`links.${deleteInfo.link.id}.`)) ||
      deleteInfo.contactIds.some((id) => path.startsWith(`contacts.${id}.`));
    const next = {
      ...scene,
      rev: scene.rev + 1,
      bodies: scene.bodies.filter((b) => !deleteInfo.bodyIds.includes(b.id)),
      supports: scene.supports.filter((s) => !deleteInfo.supportIds.includes(s.id)),
      contacts: scene.contacts.filter((c) => !deleteInfo.contactIds.includes(c.id)),
      fields: scene.fields?.filter(f=>f.id!==deleteInfo.field?.id),
      links: scene.links?.filter(l=>l.id!==deleteInfo.link?.id).map(l=>l.bodyId&&deleteInfo.bodyIds.includes(l.bodyId)?{...l,bodyId:null}:l),
      fieldPlayback: scene.fieldPlayback && (scene.fieldPlayback.fieldId === deleteInfo.field?.id ||
        scene.fieldPlayback.exit==='union'&&!scene.fields?.some(f=>f.id!==deleteInfo.field?.id&&f.enabled&&f.shape.kind!=='global'))
        ? {...scene.fieldPlayback,exit:'continue' as const,fieldId:null} : scene.fieldPlayback,
      bindings: Object.fromEntries(Object.entries(scene.bindings).filter(([path]) => !isRemoved(path) && getAt(scene, path) !== undefined)),
    };
    dispatch({ type: 'apply', scene: next });
    dispatch({ type: 'select', id: null });
    dispatch({ type: 'confirmDelete', id: null });
  }

  const showDelete = !!deleteInfo && (deleteInfo.dependentBodies.length > 0 || deleteInfo.contactIds.length > 0);

  return (
    <div className="app">
      <header className="app-header">
        <strong>高中物理工作台</strong>
        <span className="badge">本地雏形 · 确定性求解在浏览器内完成</span>
        <button onClick={()=>{
          dispatch({type:'apply',scene:{...baseScene(),rev:store.present.rev+1}});
          dispatch({type:'select',id:null});
          dispatch({type:'tool',tool:'select'});
          dispatch({type:'setDraft',draft:null});
        }}>新建场景</button>
        <select
          aria-label="载入示例"
          defaultValue=""
          onChange={(e) => {
            const ex = [...EXAMPLES, ...ELECTROMAGNETIC_EXAMPLES, ...COLLISION_EXAMPLES].find((x) => x.id === e.target.value);
            if (ex) dispatch({ type: 'load', scene: ex.build() });
            e.target.value = '';
          }}
        >
          <option value="">载入示例…</option>
          <optgroup label="力学">{EXAMPLES.map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}</optgroup>
          <optgroup label="电磁学">{ELECTROMAGNETIC_EXAMPLES.map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}</optgroup>
          <optgroup label="碰撞">{COLLISION_EXAMPLES.map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}</optgroup>
        </select>
        <button disabled={!store.past.length} onClick={() => dispatch({ type: 'undo' })}>撤销</button>
        <button disabled={!store.future.length} onClick={() => dispatch({ type: 'redo' })}>重做</button>
        <button onClick={() => exportScene(store.present)}>导出</button>
        <button onClick={() => fileRef.current?.click()}>导入</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              try {
                dispatch({ type: 'load', scene: await readSceneFile(f) });
              } catch (err) {
                alert(err instanceof Error ? err.message : String(err));
              }
            }
            e.target.value = '';
          }}
        />
        <span className="spacer" />
        <button onClick={() => openWindow('ai')}>AI 建模</button>
        <button className="primary" onClick={solveNow}>检查并求解</button>
      </header>

      <Toolbar tool={store.tool} snap={store.snap} layout={viewLayout} dispatch={dispatch} onOpen={openWindow} onReset={resetWindows} />
      {narrow && (
        <nav className="panel-tabs" aria-label="工作区面板">
          {WINDOW_IDS.map((id) => (
            <button key={id} aria-expanded={drawer === id} onClick={() => openWindow(id)}>
              {{ objects: '对象', properties: '属性', result: '结果', charts: '曲线', ai: 'AI' }[id]}
            </button>
          ))}
        </nav>
      )}

      <main className="workspace" ref={workspaceRef}>
        <section className="center">
          <Canvas store={store} dispatch={dispatch} solution={solution} edit={edit} />
        </section>
        {WINDOW_IDS.map((id) => (
          <FloatingWindow key={id} drawer={narrow} visible={viewLayout.open[id]}
            title={{ objects: '对象与代数', properties: '属性', result: '答案与推导', charts: '曲线', ai: 'AI 建模' }[id]}
            rect={viewLayout.rects[id]} z={layout.z[id]} onFocus={() => openWindow(id)}
            onClose={() => closeWindow(id)} onChange={(rect) => changeWindow(id, rect)}>
            {id === 'objects' && <ObjectList store={store} dispatch={dispatch} fields={fields} solution={solution} />}
            {id === 'properties' && <Properties store={store} dispatch={dispatch} fields={fields} />}
            {id === 'result' && <ResultPanel store={store} dispatch={dispatch} solution={solution} />}
            {id === 'charts' && <Charts solution={solution} t={store.playback.t} />}
            {id === 'ai' && <AiPanel store={store} dispatch={dispatch} onClose={() => closeWindow('ai')} />}
          </FloatingWindow>
        ))}
      </main>

      <footer className="bottom">
        <Timeline store={store} dispatch={dispatch} solution={solution} onPlay={startPlayback} />
      </footer>

      {deleteInfo && (
        <dialog ref={deleteDialogRef} className="modal small delete-dialog" aria-label="删除对象"
          onCancel={(e) => { e.preventDefault(); dispatch({ type: 'confirmDelete', id: null }); }}>
            <div className="modal-head"><strong>删除对象</strong></div>
            <div className="modal-body">
              {showDelete ? (
                <>
                  <div>以下对象会一并删除（整次删除记为一步，可撤销）：</div>
                  <ul>
                    {deleteInfo.bodyIds.map((id) => <li key={id}>物体：{store.present.bodies.find((b) => b.id === id)?.name ?? id}</li>)}
                    {deleteInfo.supportIds.map((id) => <li key={id}>支撑面：{store.present.supports.find((s) => s.id === id)?.name ?? id}</li>)}
                    {deleteInfo.contactIds.map((id) => <li key={id}>摩擦接触：{id}</li>)}
                  </ul>
                </>
              ) : (
                <div>确认删除该对象？此操作可撤销。</div>
              )}
              <div className="modal-actions">
                <button className="primary danger" onClick={confirmDelete}>删除</button>
                <button onClick={() => dispatch({ type: 'confirmDelete', id: null })}>取消</button>
              </div>
            </div>
        </dialog>
      )}
      <div className="ai-note">AI 生成内容标识：AI 仅用于读题与场景草稿，物理答案由本地解析求解器计算</div>
    </div>
  );
}
