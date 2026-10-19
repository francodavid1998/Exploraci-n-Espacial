import * as THREE from 'three';

export interface ShipModel {
  root: THREE.Group;
  flames: THREE.Mesh[];
  glows: THREE.Mesh[];
  gear: THREE.Group;
  navLights: THREE.Mesh[];
  headlight: THREE.SpotLight;
  plasma: THREE.Mesh;
  /** survival: two cannon tubes under the wings (hidden in exploration) */
  cannons: THREE.Mesh[];
  /** materials with an environment map and their base intensity (scaled with sunlight at runtime) */
  envMats: { mat: THREE.MeshStandardMaterial; base: number }[];
}

export function buildShip(env: THREE.Texture | null, plasmaMat: THREE.Material): ShipModel {
  const root = new THREE.Group();
  // The RoomEnvironment map contains light panels with radiance ~50-100: keep
  // envMapIntensity modest or the hull blooms into a white haze near the player.
  // Roughness floors: a mirror-like canopy (0.04 / clearcoat 0.02) reflecting the
  // Sun produced specular peaks > 65504 (half-float overflow -> Inf -> black screen).
  const hull = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 0.55, roughness: 0.32, envMap: env, envMapIntensity: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.7, roughness: 0.45, envMap: env, envMapIntensity: 0.25 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff6a1a, metalness: 0.3, roughness: 0.4, envMap: env, envMapIntensity: 0.2 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a1622, metalness: 0.1, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.1, envMap: env, envMapIntensity: 0.6 });

  const add = (g: THREE.BufferGeometry, m: THREE.Material, p?: [number, number, number]) => {
    const mesh = new THREE.Mesh(g, m);
    if (p) mesh.position.set(...p);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  // fuselage
  const prof: THREE.Vector2[] = [
    [0, 7.8], [0.35, 7.4], [0.8, 6.4], [1.25, 4.6], [1.55, 2.2], [1.65, -0.5], [1.6, -3.2], [1.4, -5.2], [1.1, -6.0], [0, -6.1],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const fus = new THREE.LatheGeometry(prof, 40);
  fus.rotateX(-Math.PI / 2);
  fus.scale(1.15, 0.72, 1);
  add(fus, hull);
  // dorsal spine
  const spine = new THREE.BoxGeometry(0.5, 0.5, 7, 1, 1, 1);
  add(spine, dark, [0, 1.05, 1.8]);
  // accent stripes
  const stripe = new THREE.BoxGeometry(0.12, 0.05, 5.5);
  add(stripe, accent, [0.75, 0.98, 1.0]).rotation.z = -0.35;
  add(stripe.clone(), accent, [-0.75, 0.98, 1.0]).rotation.z = 0.35;
  // canopy
  const can = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  can.scale(0.92, 0.75, 2.4);
  add(can, glass, [0, 0.62, -2.4]);
  // wings
  const ws = new THREE.Shape();
  ws.moveTo(0, -2.6);
  ws.lineTo(6.8, 1.6);
  ws.lineTo(7.4, 3.6);
  ws.lineTo(6.6, 3.9);
  ws.lineTo(0, 3.2);
  ws.lineTo(0, -2.6);
  const wg = new THREE.ExtrudeGeometry(ws, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 });
  wg.rotateX(Math.PI / 2);
  const wr = add(wg, hull, [1.1, -0.15, 0.4]);
  wr.rotation.z = -0.06;
  const wl = add(wg.clone(), hull, [-1.1, -0.15, 0.4]);
  wl.scale.x = -1;
  wl.rotation.z = 0.06;
  // wing accent edges
  const edge = new THREE.BoxGeometry(0.25, 0.3, 2.4);
  add(edge, accent, [8.3, 0.25, 3.1]);
  add(edge.clone(), accent, [-8.3, 0.25, 3.1]);
  // tail fins
  const fs = new THREE.Shape();
  fs.moveTo(0, 0); fs.lineTo(2.6, 0); fs.lineTo(3.4, 2.4); fs.lineTo(2.2, 2.4); fs.lineTo(0, 0);
  const fg = new THREE.ExtrudeGeometry(fs, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1 });
  fg.rotateY(-Math.PI / 2);
  const f1 = add(fg, dark, [0.9, 0.6, 2.6]);
  f1.rotation.z = -0.35;
  const f2 = add(fg.clone(), dark, [-0.9, 0.6, 2.6]);
  f2.rotation.z = 0.35;
  // engines
  const flames: THREE.Mesh[] = [];
  const glows: THREE.Mesh[] = [];
  const engGeo = new THREE.CylinderGeometry(0.72, 0.92, 4.6, 28);
  engGeo.rotateX(Math.PI / 2);
  const nozGeo = new THREE.CylinderGeometry(0.95, 0.75, 0.7, 28, 1, true);
  nozGeo.rotateX(Math.PI / 2);
  const glowGeo = new THREE.CircleGeometry(0.7, 28);
  const flameGeo = new THREE.ConeGeometry(0.62, 5, 24, 1, true);
  flameGeo.translate(0, 2.5, 0);
  flameGeo.rotateX(Math.PI / 2);
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 3.2, 6.0) });
  const flameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.2, 3.0), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const sx of [-2.25, 2.25]) {
    add(engGeo, hull, [sx, -0.1, 4.3]);
    add(nozGeo, dark, [sx, -0.1, 6.9]);
    const band = add(new THREE.TorusGeometry(0.86, 0.07, 8, 28), accent, [sx, -0.1, 3.2]);
    band.rotation.y = 0;
    const gl = new THREE.Mesh(glowGeo, glowMat);
    gl.position.set(sx, -0.1, 7.0);
    root.add(gl);
    glows.push(gl);
    const fl = new THREE.Mesh(flameGeo, flameMat);
    fl.position.set(sx, -0.1, 7.1);
    root.add(fl);
    flames.push(fl);
  }
  // landing gear
  const gear = new THREE.Group();
  const strut = new THREE.CylinderGeometry(0.1, 0.12, 2.2, 8);
  const pad = new THREE.CylinderGeometry(0.45, 0.5, 0.15, 16);
  for (const p of [[0, -5], [-2.3, 3.5], [2.3, 3.5]] as [number, number][]) {
    const s = new THREE.Mesh(strut, dark);
    s.position.set(p[0], -1.6, p[1]);
    s.castShadow = true;
    const pd = new THREE.Mesh(pad, dark);
    pd.position.set(p[0], -2.65, p[1]);
    pd.castShadow = true;
    gear.add(s, pd);
  }
  root.add(gear);
  // nav lights
  const navLights: THREE.Mesh[] = [];
  const nl = new THREE.SphereGeometry(0.12, 8, 8);
  const red = new THREE.Mesh(nl, new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.2, 0.1) }));
  red.position.set(-8.4, 0.35, 3.2);
  const green = new THREE.Mesh(nl, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 6, 0.4) }));
  green.position.set(8.4, 0.35, 3.2);
  const white = new THREE.Mesh(nl, new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 6) }));
  white.position.set(0, 1.35, 5.2);
  root.add(red, green, white);
  navLights.push(red, green, white);
  // headlight
  const headlight = new THREE.SpotLight(0xffffff, 0, 900, 0.45, 0.5, 1.2);
  headlight.position.set(0, -0.3, -7);
  headlight.target.position.set(0, -2.5, -40);
  root.add(headlight, headlight.target);
  // reentry plasma shell
  const plasma = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), plasmaMat);
  plasma.scale.set(10, 6, 13);
  plasma.visible = false;
  root.add(plasma);
  // cannon tubes under the wings, where the ship's bolts come from (survival shows them)
  const cannons: THREE.Mesh[] = [];
  const tube = new THREE.CylinderGeometry(0.16, 0.2, 3.2, 10).rotateX(Math.PI / 2);
  for (const x of [-5.2, 5.2]) {
    const c = new THREE.Mesh(tube, dark);
    c.position.set(x, -0.3, -1.6);
    c.castShadow = true;
    c.visible = false;
    root.add(c);
    cannons.push(c);
  }
  const envMats = [hull, dark, accent, glass].map((m) => ({ mat: m as THREE.MeshStandardMaterial, base: m.envMapIntensity }));
  return { root, flames, glows, gear, navLights, headlight, plasma, cannons, envMats };
}

export interface AstroModel {
  root: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  jet: THREE.Mesh[];
  lamp: THREE.SpotLight;
  /** survival: the weapon in the right hand (hidden in exploration) */
  weapons: { rifle: THREE.Group; dispersor: THREE.Group };
  envMats: { mat: THREE.MeshStandardMaterial; base: number }[];
}

export function buildAstronaut(env: THREE.Texture | null): AstroModel {
  const root = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.78, metalness: 0.02 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x7d838a, roughness: 0.55, metalness: 0.4, envMap: env, envMapIntensity: 0.25 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 });
  const visor = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.18, metalness: 1, envMap: env, envMapIntensity: 0.6 });
  const m = (g: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, p: [number, number, number]) => {
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(...p);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const torso = m(new THREE.CapsuleGeometry(0.25, 0.42, 6, 16), suit, root, [0, 1.22, 0]);
  torso.scale.set(1.05, 1, 0.82);
  m(new THREE.BoxGeometry(0.44, 0.58, 0.24), grey, root, [0, 1.27, 0.25]);
  m(new THREE.BoxGeometry(0.28, 0.14, 0.06), grey, root, [0, 1.3, -0.23]);
  m(new THREE.CylinderGeometry(0.16, 0.18, 0.06, 16), grey, root, [0, 1.52, 0]);
  m(new THREE.SphereGeometry(0.21, 24, 16), suit, root, [0, 1.7, 0]);
  const vg = new THREE.SphereGeometry(0.185, 24, 16, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.22, Math.PI * 0.45);
  vg.rotateY(Math.PI);
  m(vg, visor, root, [0, 1.71, -0.035]);
  const mkLimb = (x: number, y: number, len: number, rad: number) => {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    m(new THREE.CapsuleGeometry(rad, len, 4, 12), suit, g, [0, -len / 2 - rad * 0.5, 0]);
    root.add(g);
    return g;
  };
  const armL = mkLimb(-0.33, 1.47, 0.48, 0.085);
  const armR = mkLimb(0.33, 1.47, 0.48, 0.085);
  m(new THREE.BoxGeometry(0.19, 0.06, 0.19), orange, armL, [0, -0.2, 0]);
  m(new THREE.BoxGeometry(0.19, 0.06, 0.19), orange, armR, [0, -0.2, 0]);
  const legL = mkLimb(-0.13, 0.92, 0.6, 0.1);
  const legR = mkLimb(0.13, 0.92, 0.6, 0.1);
  m(new THREE.BoxGeometry(0.17, 0.12, 0.3), grey, legL, [0, -0.86, -0.04]);
  m(new THREE.BoxGeometry(0.17, 0.12, 0.3), grey, legR, [0, -0.86, -0.04]);
  const jet: THREE.Mesh[] = [];
  const jg = new THREE.ConeGeometry(0.08, 0.7, 12, 1, true);
  jg.translate(0, -0.35, 0);
  const jm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.4, 3.5), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const x of [-0.13, 0.13]) {
    const j = new THREE.Mesh(jg, jm);
    j.position.set(x, 0.98, 0.33);
    j.visible = false;
    root.add(j);
    jet.push(j);
  }
  const lamp = new THREE.SpotLight(0xfff4e0, 0, 120, 0.5, 0.45, 1.2);
  lamp.position.set(0, 1.75, -0.25);
  lamp.target.position.set(0, 0.6, -8);
  root.add(lamp, lamp.target);
  // the weapons, held in the right hand along the forearm (the barrel continues the arm)
  const gun = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.5, metalness: 0.5 });
  const coil = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.45, 0.55) });
  const rifle = new THREE.Group();
  m(new THREE.BoxGeometry(0.08, 0.34, 0.1), gun, rifle, [0, -0.66, -0.03]);
  m(new THREE.CylinderGeometry(0.02, 0.022, 0.26, 8), gun, rifle, [0, -0.95, -0.03]);
  m(new THREE.TorusGeometry(0.035, 0.008, 6, 12).rotateX(Math.PI / 2), coil, rifle, [0, -0.86, -0.03]).castShadow = false;
  const dispersor = new THREE.Group();
  m(new THREE.BoxGeometry(0.17, 0.3, 0.14), gun, dispersor, [0, -0.66, -0.03]);
  for (const x of [-0.05, 0, 0.05]) m(new THREE.CylinderGeometry(0.022, 0.026, 0.16, 8), gun, dispersor, [x, -0.88, -0.03]);
  rifle.visible = dispersor.visible = false;
  armR.add(rifle, dispersor);
  const envMats = [grey, visor].map((m) => ({ mat: m, base: m.envMapIntensity }));
  return { root, legL, legR, armL, armR, jet, lamp, weapons: { rifle, dispersor }, envMats };
}
