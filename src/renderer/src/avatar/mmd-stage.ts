/**
 * MMD stage — renders a PMX model in the overlay.
 *
 * Babylon and babylon-mmd are loaded dynamically so the 100MB+ of 3D runtime
 * never touches the main window's bundle; only the avatar surface pays for
 * it, and only when a model is actually shown.
 *
 * Three things here are load-bearing and were each learned the hard way:
 *  · `MultiPhysicsRuntime.dispose()` spin-waits on a wasm lock whose timeout
 *    is compiled out — disposing it hard-locks the process. So the physics
 *    runtime is a page-global singleton: created once, registered per scene,
 *    NEVER disposed. Switching models unregisters instead.
 *  · `Bone.rotationQuaternion`'s getter returns a COPY. Mutating it does
 *    nothing; the setter is the only way to move a bone.
 *  · `createMmdModel` trims the metadata it read, so morph and material
 *    lists must be captured BEFORE constructing the model.
 */
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Scene } from '@babylonjs/core/scene';

export interface StageHandle {
  dispose(): void;
  /** 0..1 mouth open, driven by TTS amplitude later */
  setMouth(weight: number): void;
  setExpression(name: string | null): void;
  morphNames(): string[];
}

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** file:// URL of the .pmx */
  modelUrl: string;
  onReady?(info: { morphs: string[]; physics: boolean }): void;
  onError?(message: string): void;
}

/** ONE physics runtime per page. See the class docblock: disposing it is a
 *  hard lock, so it is created once and reused across model switches. */
let sharedPhysics: { register(s: Scene): void; unregister(): void } | null = null;
let sharedPhysicsFailed = false;
let physicsOwner: object | null = null;

async function ensurePhysics(): Promise<typeof sharedPhysics> {
  if (sharedPhysics || sharedPhysicsFailed) return sharedPhysics;
  try {
    const [{ GetMmdWasmInstance }, { MmdWasmInstanceTypeSPR }, { MultiPhysicsRuntime }] =
      await Promise.all([
        import('babylon-mmd/esm/Runtime/Optimized/mmdWasmInstance'),
        import('babylon-mmd/esm/Runtime/Optimized/InstanceType/singlePhysicsRelease'),
        import('babylon-mmd/esm/Runtime/Optimized/Physics/Bind/Impl/multiPhysicsRuntime'),
      ]);
    const { Vector3 } = await import('@babylonjs/core/Maths/math.vector');
    const wasm = await GetMmdWasmInstance(new MmdWasmInstanceTypeSPR());
    const runtime = new MultiPhysicsRuntime(wasm);
    runtime.setGravity(new Vector3(0, -98, 0));
    sharedPhysics = runtime as unknown as typeof sharedPhysics;
  } catch {
    // hair and skirts stop swaying; everything else still works
    sharedPhysicsFailed = true;
  }
  return sharedPhysics;
}

function bindPhysics(owner: object, scene: Scene): void {
  if (!sharedPhysics) return;
  // register() no-ops while bound to any scene and unregister() detaches
  // whatever is bound, so ownership has to be explicit
  sharedPhysics.unregister();
  sharedPhysics.register(scene);
  physicsOwner = owner;
}

function unbindPhysics(owner: object): void {
  if (physicsOwner !== owner) return;
  try {
    sharedPhysics?.unregister();
  } catch {
    /* best effort */
  }
  physicsOwner = null;
}

const BLINK_MORPHS = ['まばたき', 'blink', 'Blink'];
const MOUTH_MORPHS = ['あ', 'a', 'A'];

export async function createMmdStage(options: StageOptions): Promise<StageHandle> {
  const [
    { Engine: EngineCtor },
    { Scene: SceneCtor },
    { Color4 },
    { Vector3 },
    { ArcRotateCamera },
    { HemisphericLight },
    { DirectionalLight },
    { LoadAssetContainerAsync },
    { SdefInjector },
    { MmdStandardMaterialBuilder },
    { MmdRuntime },
  ] = await Promise.all([
    import('@babylonjs/core/Engines/engine'),
    import('@babylonjs/core/scene'),
    import('@babylonjs/core/Maths/math.color'),
    import('@babylonjs/core/Maths/math.vector'),
    import('@babylonjs/core/Cameras/arcRotateCamera'),
    import('@babylonjs/core/Lights/hemisphericLight'),
    import('@babylonjs/core/Lights/directionalLight'),
    import('@babylonjs/core/Loading/sceneLoader'),
    import('babylon-mmd/esm/Loader/sdefInjector'),
    import('babylon-mmd/esm/Loader/mmdStandardMaterialBuilder'),
    import('babylon-mmd/esm/Runtime/mmdRuntime'),
  ]);
  await import('babylon-mmd/esm/Loader/pmxLoader');
  await import('babylon-mmd/esm/Loader/mmdOutlineRenderer');

  const engine: Engine = new EngineCtor(options.canvas, true, {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  SdefInjector.OverrideEngineCreateEffect(engine);

  const scene: Scene = new SceneCtor(engine);
  // fully transparent so the desktop shows through
  scene.clearColor = new Color4(0, 0, 0, 0);
  scene.autoClear = true;

  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 26, new Vector3(0, 12, 0), scene);
  new HemisphericLight('h', new Vector3(0, 1, 0), scene).intensity = 0.7;
  new DirectionalLight('d', new Vector3(0.4, -1, 0.7), scene).intensity = 0.7;

  const owner = {};
  let disposed = false;

  const container = await LoadAssetContainerAsync(options.modelUrl, scene, {
    pluginOptions: {
      mmdmodel: { materialBuilder: new MmdStandardMaterialBuilder(), loggingEnabled: false },
    },
  });
  if (disposed) {
    container.dispose();
    engine.dispose();
    throw new Error('stage disposed while loading');
  }
  container.addAllToScene();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootMesh = container.meshes[0] as any;
  // capture BEFORE createMmdModel — it trims the metadata it read
  const morphNames: string[] = (rootMesh?.metadata?.morphs ?? [])
    .map((m: { name?: string }) => m?.name)
    .filter((n: unknown): n is string => typeof n === 'string');

  const physics = await ensurePhysics();
  let mmdPhysics: unknown = null;
  if (physics && !disposed) {
    const { MmdBulletPhysics } = await import(
      'babylon-mmd/esm/Runtime/Optimized/Physics/mmdBulletPhysics'
    );
    bindPhysics(owner, scene);
    mmdPhysics = new MmdBulletPhysics(physics as never);
  }

  const runtime = new MmdRuntime(scene, mmdPhysics as never);
  runtime.register(scene);
  const model = runtime.createMmdModel(rootMesh, { buildPhysics: Boolean(mmdPhysics) });

  // frame the model: read its real height rather than guessing a camera
  const bounds = rootMesh.getHierarchyBoundingVectors();
  const height = Math.max(bounds.max.y - Math.max(bounds.min.y, 0), 1);
  camera.radius = Math.min(Math.max(height * 1.25, 8), 90);
  camera.setTarget(new Vector3(0, Math.max(bounds.min.y, 0) + height * 0.62, 0));

  const setMorph = (name: string, weight: number): void => {
    try {
      model.morph.setMorphWeight(name, weight);
    } catch {
      /* a model without this morph simply does not have the expression */
    }
  };
  const pick = (candidates: string[]): string | null =>
    candidates.find((c) => morphNames.includes(c)) ?? null;

  const blinkMorph = pick(BLINK_MORPHS);
  const mouthMorph = pick(MOUTH_MORPHS);
  let mouth = 0;
  let expression: string | null = null;
  let nextBlinkAt = performance.now() + 2200;
  let blinkPhase = -1;

  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const dt = engine.getDeltaTime();

    // breathing keeps a still model from reading as a frozen screenshot
    const breath = Math.sin((now % 4200) / 4200 * Math.PI * 2);
    const upper = model.skeleton?.bones?.find?.((b: { name: string }) => b.name === '上半身');
    if (upper) {
      // the getter returns a COPY — only the setter moves a bone
      const q = upper.rotationQuaternion.clone();
      q.x = breath * 0.012;
      upper.rotationQuaternion = q;
    }

    if (mouthMorph) setMorph(mouthMorph, mouth);
    if (expression) setMorph(expression, 1);

    if (blinkMorph) {
      if (blinkPhase < 0 && now >= nextBlinkAt) blinkPhase = 0;
      if (blinkPhase >= 0) {
        blinkPhase = Math.min(1, blinkPhase + dt / 170);
        setMorph(blinkMorph, blinkPhase < 0.5 ? blinkPhase * 2 : (1 - blinkPhase) * 2);
        if (blinkPhase >= 1) {
          blinkPhase = -1;
          setMorph(blinkMorph, 0);
          nextBlinkAt = now + 2500 + Math.random() * 3500;
        }
      }
    }
  });

  engine.runRenderLoop(() => scene.render());
  const onResize = (): void => engine.resize();
  window.addEventListener('resize', onResize);

  options.onReady?.({ morphs: morphNames, physics: Boolean(mmdPhysics) });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', onResize);
      try {
        // order matters: the model leaves the physics world before the
        // runtime that owns it goes away
        runtime.destroyMmdModel(model);
      } catch {
        /* already gone */
      }
      unbindPhysics(owner);
      scene.dispose();
      engine.dispose();
    },
    setMouth(weight: number): void {
      mouth = Math.min(1, Math.max(0, weight));
    },
    setExpression(name: string | null): void {
      if (expression && expression !== name) setMorph(expression, 0);
      expression = name && morphNames.includes(name) ? name : null;
    },
    morphNames(): string[] {
      return morphNames;
    },
  };
}
