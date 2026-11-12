import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { store, useApp } from '../state/store';
import { onFrame } from '../state/frame';
import { addSource, selectSource, setListenerHeight, setSourcePos, toast } from '../state/actions';
import { engine } from '../audio/engine';
import { anySolo, computeState, listenerYaw } from '../audio/spatial';
import { motionGain, motionPeriod, pathStart, positionAt } from '../scene/motion';
import { DEG } from '../audio/util';
import type { Source } from '../scene/types';

// Same axes as Web Audio: +x right, +y up, −z front, in metres. Audio positions are relative to the ears;
// in the 3D world the floor is y = 0, so audio y + earHeight = 3D y. Moving the listener up then leaves the room in place.

const BALL_R = 0.17;
const PATH_POINTS = 240;
const RINGS = [1, 2, 5, 10, 20, 50, 100];

interface SrcObj {
  ball: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  stem: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  ghost: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  path: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  pathFor: Source | null;
  anchor: THREE.Mesh<THREE.OctahedronGeometry, THREE.MeshBasicMaterial>;
  cone: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  coneFor: number;
  label: CSS2DObject;
  labelName: HTMLSpanElement;
  labelHeight: HTMLSpanElement;
  color: string;
}

type Drag =
  | { mode: 'move'; id: string; plane: THREE.Plane; ox: number; oz: number }
  | { mode: 'height'; id: string; plane: THREE.Plane; y0: number; h0: number }
  | { mode: 'listener'; plane: THREE.Plane; y0: number; h0: number };

export function ThreeView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const api = useRef<{ reset: () => void; overhead: () => void } | null>(null);
  const [failed, setFailed] = useState(false);
  const earHeight = useApp((s) => s.scene.physics.earHeight);

  useEffect(() => {
    const wrap = wrapRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.domElement.className = 'three-canvas';
    wrap.prepend(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'three-labels';
    wrap.append(labels.domElement);

    const scene = new THREE.Scene();
    const bg = new THREE.Color('#0b0e14');
    scene.background = bg;
    scene.fog = new THREE.Fog(bg, 70, 260);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);

    scene.add(new THREE.HemisphereLight('#dbe4f0', '#1a2030', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(6, 12, 8);
    scene.add(sun);

    // ---------------------------------------------------------------- floor
    const floor = new THREE.Group();
    scene.add(floor);
    const fine = new THREE.GridHelper(40, 40, '#3a4558', '#1f2633');
    const coarse = new THREE.GridHelper(400, 40, '#3a4558', '#1a202b');
    for (const g of [fine, coarse]) {
      const m = g.material as THREE.Material;
      m.transparent = true;
      m.opacity = g === fine ? 0.9 : 0.6;
      floor.add(g);
    }
    coarse.position.y = -0.005;
    const ringMat = new THREE.LineBasicMaterial({ color: '#4fd1c5', transparent: true, opacity: 0.22 });
    for (const r of RINGS) {
      const pts = Array.from({ length: 129 }, (_, i) => {
        const a = (i / 128) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * r, 0.01, Math.sin(a) * r);
      });
      floor.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
      const el = document.createElement('span');
      el.className = 'lbl3d ring';
      el.textContent = `${r} m`;
      const lab = new CSS2DObject(el);
      lab.position.set(r * 0.707, 0.02, r * 0.707);
      floor.add(lab);
    }

    // ---------------------------------------------------------------- listener
    const person = new THREE.Group();
    scene.add(person);
    const skin = new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.6 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 16), skin);
    person.add(head);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 16), new THREE.MeshStandardMaterial({ color: '#4fd1c5' }));
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.12;
    person.add(nose);
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshStandardMaterial({ color: '#94a3b8' }));
      ear.scale.set(0.6, 1.3, 1);
      ear.position.x = sx * 0.1;
      person.add(ear);
    }
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 1, 24), new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.8 }));
    person.add(body);
    const fov = new THREE.Mesh(
      new THREE.CircleGeometry(2.2, 32, Math.PI / 2 - 0.5, 1.0),
      new THREE.MeshBasicMaterial({ color: '#4fd1c5', transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    fov.rotation.x = -Math.PI / 2;
    person.add(fov);
    // Above standing height the person stands on a platform (a gallery, a tower…).
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1, 0.9).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.9, transparent: true, opacity: 0.55 }),
    );
    scene.add(platform);
    const personTargets: THREE.Object3D[] = [head, nose, body];
    const earLabelEl = document.createElement('div');
    earLabelEl.className = 'lbl3d you';
    const earLabel = new CSS2DObject(earLabelEl);
    earLabel.center.set(1.15, 0.5);
    scene.add(earLabel);

    // ---------------------------------------------------------------- height handle (shown on the selected source)
    const handle = new THREE.Group();
    const handleMat = new THREE.MeshBasicMaterial({ color: '#f8fafc' });
    const up = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 16), handleMat);
    up.position.y = 0.2;
    const down = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 16), handleMat);
    down.rotation.x = Math.PI;
    down.position.y = -0.0;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 8), handleMat);
    shaft.position.y = 0.1;
    // A bigger invisible grab target makes the handle easy to hit.
    const grab = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 12), new THREE.MeshBasicMaterial({ visible: false }));
    grab.position.y = 0.1;
    handle.add(up, down, shaft, grab);
    handle.visible = false;
    scene.add(handle);
    const handleTargets: THREE.Object3D[] = [up, down, shaft, grab];

    // ---------------------------------------------------------------- camera + controls
    const domEl = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const objs = new Map<string, SrcObj>();
    let drag: Drag | null = null;

    const setNdc = (e: PointerEvent | MouseEvent) => {
      const r = domEl.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
    };
    type Pick = { kind: 'source'; id: string; handle: boolean } | { kind: 'listener' };
    const pick = (): Pick | null => {
      const balls = [...objs.entries()].map(([id, o]) => ((o.ball.userData.id = id), o.ball));
      const targets: THREE.Object3D[] = [...(handle.visible ? handleTargets : []), ...balls, ...personTargets];
      const hit = raycaster.intersectObjects(targets, false)[0];
      if (!hit) return null;
      if (personTargets.includes(hit.object)) return { kind: 'listener' };
      if (handleTargets.includes(hit.object)) return { kind: 'source', id: store.get().selectedSourceId!, handle: true };
      return { kind: 'source', id: hit.object.userData.id as string, handle: false };
    };
    /** A vertical plane through `at`, facing the camera: dragging on it changes height. */
    const verticalPlane = (at: THREE.Vector3) => {
      const n = camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      return new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), at);
    };
    const earY = () => store.get().scene.physics.earHeight;
    const ballPos = (id: string) => objs.get(id)?.ball.position.clone() ?? new THREE.Vector3();
    const round = (v: number) => Math.round(v * 100) / 100;

    // Registered before OrbitControls, so a hit on a source can stop the orbit gesture.
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      setNdc(e);
      const p = pick();
      if (!p) return;
      e.stopImmediatePropagation();
      const hit = new THREE.Vector3();
      if (p.kind === 'listener') {
        const plane = verticalPlane(new THREE.Vector3(0, earY(), 0));
        if (!raycaster.ray.intersectPlane(plane, hit)) return;
        drag = { mode: 'listener', plane, y0: hit.y, h0: earY() };
        domEl.setPointerCapture(e.pointerId);
        domEl.style.cursor = 'ns-resize';
        return;
      }
      selectSource(p.id);
      const src = store.get().scene.sources.find((s) => s.id === p.id)!;
      const at = ballPos(p.id);
      if (p.handle || e.shiftKey) {
        const plane = verticalPlane(at);
        if (!raycaster.ray.intersectPlane(plane, hit)) return;
        drag = { mode: 'height', id: p.id, plane, y0: hit.y, h0: src.pos.y };
      } else {
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -at.y);
        if (!raycaster.ray.intersectPlane(plane, hit)) return;
        drag = { mode: 'move', id: p.id, plane, ox: src.pos.x - hit.x, oz: src.pos.z - hit.z };
      }
      domEl.setPointerCapture(e.pointerId);
      domEl.style.cursor = drag.mode === 'height' ? 'ns-resize' : 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      setNdc(e);
      if (!drag) {
        const p = pick();
        domEl.style.cursor = p ? (p.kind === 'listener' || p.handle ? 'ns-resize' : 'grab') : 'default';
        return;
      }
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(drag.plane, hit)) return;
      if (drag.mode === 'move') {
        setSourcePos(drag.id, { x: round(hit.x + drag.ox), z: round(hit.z + drag.oz) });
      } else if (drag.mode === 'height') {
        setSourcePos(drag.id, { y: round(Math.max(-earY(), drag.h0 + hit.y - drag.y0)) });
      } else {
        const h = drag.h0 + hit.y - drag.y0;
        setListenerHeight(h < 2 ? round(h) : Math.round(h * 10) / 10);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      domEl.releasePointerCapture(e.pointerId);
      domEl.style.cursor = 'default';
    };
    const onDbl = (e: MouseEvent) => {
      setNdc(e);
      if (pick()) return;
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -earY()), hit)) return;
      const st = store.get();
      const soundId = st.selectedSoundId ?? st.sounds[0]?.id ?? null;
      if (!soundId) return toast('Create or record a sound first.');
      addSource(soundId, { x: round(hit.x), y: 0, z: round(hit.z) });
    };
    domEl.addEventListener('pointerdown', onDown);
    domEl.addEventListener('pointermove', onMove);
    domEl.addEventListener('pointerup', onUp);
    domEl.addEventListener('dblclick', onDbl);

    const controls = new OrbitControls(camera, domEl);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.5;
    controls.maxDistance = 600;
    const reset = () => {
      const E = earY();
      camera.position.set(5.5, E + 4.5, 9);
      controls.target.set(0, E - 0.6, -2.5);
      controls.update();
    };
    const overhead = () => {
      const E = earY();
      camera.position.set(0, E + 26, 0.01);
      controls.target.set(0, E, 0);
      controls.update();
    };
    reset();
    api.current = { reset, overhead };

    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height);
      labels.setSize(r.width, r.height);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    });
    ro.observe(wrap);

    // ---------------------------------------------------------------- per-source objects

    const makeObj = (src: Source): SrcObj => {
      const color = new THREE.Color(src.color);
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_R, 32, 16),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.35, transparent: true }),
      );
      const stem = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }),
      );
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(BALL_R * 1.1, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }),
      );
      shadow.rotation.x = -Math.PI / 2;
      const ghost = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_R, 12, 8),
        new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.45 }),
      );
      const path = new THREE.Line(
        new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array((PATH_POINTS + 1) * 3), 3)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 }),
      );
      const anchor = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }));
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(1, 1, 32, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
      );
      const el = document.createElement('div');
      el.className = 'lbl3d src';
      const labelName = document.createElement('span');
      const labelHeight = document.createElement('small');
      el.append(labelName, labelHeight);
      const label = new CSS2DObject(el);
      label.center.set(-0.12, 0.5);
      scene.add(ball, stem, shadow, ghost, path, anchor, cone, label);
      return { ball, stem, shadow, ghost, path, pathFor: null, anchor, cone, coneFor: -1, label, labelName, labelHeight, color: src.color };
    };

    const disposeObj = (o: SrcObj) => {
      for (const m of [o.ball, o.stem, o.shadow, o.ghost, o.path, o.anchor, o.cone]) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      }
      scene.remove(o.label);
      o.label.element.remove();
    };

    const camPos = new THREE.Vector3();
    const unsub = onFrame(() => {
      const st = store.get();
      const sc = st.scene;
      const ph = sc.physics;
      const E = ph.earHeight; // audio y + E = 3D y; the floor is at 3D y = 0
      const t = engine.time();
      const solo = anySolo(sc);

      // The listener: a person no taller than standing height, on a platform if the ears are higher.
      const stand = Math.min(E, 1.6);
      person.position.y = E;
      person.rotation.y = -listenerYaw(sc, t) * DEG;
      body.scale.y = Math.max(0.02, stand - 0.22);
      body.position.y = -stand + body.scale.y / 2;
      fov.position.y = -stand + 0.02;
      platform.visible = E - stand > 0.02;
      platform.scale.y = Math.max(0.01, E - stand);
      earLabel.position.set(0, E, 0);
      const earText = `ears ${E < 10 ? E.toFixed(2).replace(/0$/, '') : E.toFixed(1)} m up`;
      if (earLabelEl.textContent !== earText) earLabelEl.textContent = earText;
      camPos.copy(camera.position);

      const seen = new Set<string>();
      for (const src of sc.sources) {
        seen.add(src.id);
        let o = objs.get(src.id);
        if (!o) {
          o = makeObj(src);
          objs.set(src.id, o);
        }
        if (o.color !== src.color) {
          const c = new THREE.Color(src.color);
          o.ball.material.color.copy(c);
          o.ball.material.emissive.copy(c);
          for (const m of [o.stem.material, o.shadow.material, o.ghost.material, o.path.material, o.anchor.material, o.cone.material]) m.color.copy(c);
          o.color = src.color;
        }
        const s = computeState(src, sc, t, solo);
        const p = s.now;
        const selected = src.id === st.selectedSourceId;
        const audible = !src.muted && (!solo || src.solo) && !!src.soundId;
        const presence = audible ? Math.max(0.3, motionGain(src, t)) : 0.3;
        const k = Math.max(1, camPos.distanceTo(o.ball.position) / 14);

        o.ball.position.set(p.x, p.y + E, p.z);
        o.ball.scale.setScalar(k * (selected ? 1.15 : 1));
        o.ball.material.opacity = presence;
        o.ball.material.emissiveIntensity = 0.25 + Math.min(1, engine.level(src.id) * 4) * 1.5 + (selected ? 0.25 : 0);

        // Stem from the floor up to the source, and a "shadow" on the floor: shows height at a glance.
        const pos = o.stem.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, p.x, 0, p.z);
        pos.setXYZ(1, p.x, p.y + E, p.z);
        pos.needsUpdate = true;
        o.stem.geometry.computeBoundingSphere();
        o.shadow.position.set(p.x, 0.012, p.z);
        o.shadow.scale.setScalar(k);

        // Where the sound is heard from (behind the source when sound is slow)
        const lag = Math.hypot(s.heard.x - p.x, s.heard.y - p.y, s.heard.z - p.z);
        o.ghost.visible = lag > 0.3;
        o.ghost.position.set(s.heard.x, s.heard.y + E, s.heard.z);
        o.ghost.scale.setScalar(k);

        // Motion path
        const moving = src.motion.type !== 'static';
        o.path.visible = moving;
        o.path.material.opacity = selected ? 0.75 : 0.3;
        o.anchor.visible = moving;
        o.path.position.y = E; // points are in audio coordinates
        if (moving && (o.pathFor !== src || src.motion.type === 'wander')) {
          const t0 = pathStart(src, t);
          const P = Math.min(motionPeriod(src), 120);
          const arr = o.path.geometry.attributes.position as THREE.BufferAttribute;
          for (let i = 0; i <= PATH_POINTS; i++) {
            const q = positionAt(src, t0 + (i / PATH_POINTS) * P);
            arr.setXYZ(i, q.x, q.y, q.z);
          }
          arr.needsUpdate = true;
          o.path.geometry.computeBoundingSphere();
          o.pathFor = src;
        }
        o.anchor.position.set(src.pos.x, src.pos.y + E, src.pos.z);

        // Directivity cone, apex at the source
        o.cone.visible = !!s.orient;
        if (s.orient) {
          const L = 1.6;
          if (o.coneFor !== src.coneInner) {
            const half = Math.min(85, src.coneInner / 2) * DEG;
            o.cone.geometry.dispose();
            o.cone.geometry = new THREE.ConeGeometry(Math.tan(half) * L, L, 32, 1, true).translate(0, -L / 2, 0);
            o.coneFor = src.coneInner;
          }
          o.cone.position.copy(o.ball.position);
          o.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(s.orient.x, s.orient.y, s.orient.z));
          o.cone.scale.setScalar(k);
        }

        // Label
        o.label.position.set(p.x, p.y + E, p.z);
        o.label.element.style.opacity = String(presence);
        o.label.element.classList.toggle('sel', selected);
        if (o.labelName.textContent !== src.name) o.labelName.textContent = src.name;
        const h = p.y;
        const ht = Math.abs(h) < 0.05 ? 'ear level' : `${h > 0 ? '▲' : '▼'} ${Math.abs(h).toFixed(1)} m ${h > 0 ? 'above' : 'below'} ears`;
        if (o.labelHeight.textContent !== ht) o.labelHeight.textContent = ht;

        if (selected) {
          handle.visible = true;
          handle.position.set(p.x, p.y + E + (BALL_R + 0.12) * k, p.z);
          handle.scale.setScalar(k);
        }
      }
      if (!st.selectedSourceId || !seen.has(st.selectedSourceId)) handle.visible = false;
      for (const [id, o] of objs) {
        if (!seen.has(id)) {
          disposeObj(o);
          objs.delete(id);
        }
      }

      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
    });

    return () => {
      unsub();
      ro.disconnect();
      controls.dispose();
      domEl.removeEventListener('pointerdown', onDown);
      domEl.removeEventListener('pointermove', onMove);
      domEl.removeEventListener('pointerup', onUp);
      domEl.removeEventListener('dblclick', onDbl);
      for (const o of objs.values()) disposeObj(o);
      renderer.dispose();
      domEl.remove();
      labels.domElement.remove();
      api.current = null;
    };
  }, []);

  return (
    <div className="scene-wrap three-wrap" ref={wrapRef}>
      {failed && <div className="three-fail">WebGL is not available in this browser, so the 3D view is disabled.</div>}
      <div className="scene-tag">3D view · your ears are {earHeight} m above the floor</div>
      <div className="scene-zoom">
        <button onClick={() => api.current?.reset()} title="Back to the default camera">Reset</button>
        <button onClick={() => api.current?.overhead()} title="Look straight down">Overhead</button>
      </div>
      <div className="scene-help">
        Drag empty space to orbit · right-drag to pan · scroll to zoom · drag a ball to move it · drag the white <b>⇕</b> handle (or <kbd>Shift</kbd>+drag) to change height · drag the listener to raise or lower yourself
      </div>
    </div>
  );
}
