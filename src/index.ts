import * as THREE from "three";
import XRmanager from "./XRmanager";
import TextMaker, { TextInstance } from "./TextMaker";
import { GPUComputationRenderer, Variable } from "./GPUComputationRenderer";
import computeVelocity from "./shaders/computeVelocity.glsl";
import computePosition from "./shaders/computePosition.glsl";
import computeAggregate from "./shaders/computeAggregate.glsl";
import knightVertex from "./shaders/knight.vertex.glsl";
import knightFragment from "./shaders/knight.fragment.glsl";
import { OrbitControls } from "./OrbitControls";
import { playRandomSoundAtPosition } from "./sounds";
import Music from "./music";
import { createGrass } from "./grass";

type Unit = {
  pos: THREE.Vector3;
  rot: THREE.Vector3;
  start: THREE.Mesh;
  target: THREE.Mesh;
  owner: "p" | "e";
};

// P is player, E si enemy
const controllers: THREE.Group[] = [];
let lastGenerationTime: number;
const WIDTH = 64;
const PARTICLES = WIDTH * WIDTH;
let knightUniforms: any;
const targets: (THREE.Mesh | null)[] = Array(WIDTH).fill(null);

let renderer: THREE.WebGLRenderer;
let gpuCompute: GPUComputationRenderer;
let velocityVariable: Variable;
let positionVariable: any;
let aggregateVariable: any;
let textMaker: TextMaker;
// let isDragging = false;
let gameStarted = false;
let currentTime = 0;
let rotator: THREE.Object3D;
const unitQueue: Unit[] = [];

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const dtAggregateBuffer = new Float32Array(PARTICLES * 4);
const dtVelocityBuffer = new Float32Array(PARTICLES * 4);
const dtPositionBuffer = new Float32Array(PARTICLES * 4);
const computeCallbacks: { [key: string]: ((buffer: Float32Array) => void)[] } = {};
// const toReset: number[] = [];
// This is a lock to prevent aggregation calculations while async unit launch is in progress
let syncInProgress = false;
const unitsFound = {
  p: 0,
  e: 0,
};

let oldVolume = 0.0;

let frame = 0;
// Blowing mechanic
let analyzer: AnalyserNode;
let mic;
const blowingThreshold = 0.3;

let selectedTarget: THREE.Mesh | null = null;
// let enemies: THREE.Mesh[] = [];
let grassInstances: THREE.InstancedMesh;

let dandelionToRemove: THREE.Object3D | null = null;

// let lastRotationTime = 0;
const cameraDirection = new THREE.Vector3();

let pickedUpDandelion: THREE.Object3D | null = null;
const fftArray: Uint8Array = new Uint8Array(32);
// class CustomGroup extends THREE.Group {
//   u: any = {};
// }

const colors = {
  player: new THREE.Color(0x00c52f),
  enemy: new THREE.Color(0xc52f34),
  playerUI: new THREE.Color(0x00ff00),
  enemyUI: new THREE.Color(0xff0000),
};

let dandelions: THREE.Object3D[] = [];

function fillTextures(tP: THREE.DataTexture, tV: THREE.DataTexture) {
  const posArray = tP.image.data;
  const velArray = tV.image.data;

  // velocityTexture.w is target castle

  for (let k = 0, kl = posArray.length; k < kl; k += 4) {
    // First row of the texture (WIDTH), is the castle locations
    if (k < 4 * WIDTH) {
      if (targets[k / 4]) {
        // console.log("place", places[k / 4].position);
        posArray[k + 0] = 0; //places[k / 4].position.x;
        posArray[k + 1] = 0; // places[k / 4].position.y;
        posArray[k + 2] = 0; //places[k / 4].position.z;
        posArray[k + 3] = 0.1; // fixed
        velArray[k + 3] = 1.0; // mass
      } else {
        posArray[k + 0] = 0;
        posArray[k + 1] = 0;
        posArray[k + 2] = 0;
        posArray[k + 3] = 0.1;
        velArray[k + 3] = 1.0;
      }
    } else {
      // units/units
      posArray[k + 0] = 0;
      posArray[k + 1] = 0; //Math.random();
      posArray[k + 2] = 0;
      posArray[k + 3] = 99;

      velArray[k + 0] = 0; //1.0;
      velArray[k + 1] = 0; //0.5 - Math.random();
      velArray[k + 2] = 0; // 0.5 - Math.random();
      velArray[k + 3] = 0; // mass / 1000.0;
    }
  }
}

function initComputeRenderer() {
  gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);
  const dtPosition = gpuCompute.createTexture();
  const dtVelocity = gpuCompute.createTexture();
  const dtAggregate = gpuCompute.createTexture();
  fillTextures(dtPosition, dtVelocity);
  velocityVariable = gpuCompute.addVariable("tV", computeVelocity, dtVelocity, dtVelocityBuffer);
  (velocityVariable.material as any).uniforms.d = { value: 3 };

  positionVariable = gpuCompute.addVariable("tP", computePosition, dtPosition, dtPositionBuffer);
  aggregateVariable = gpuCompute.addVariable(
    "tA",
    computeAggregate,
    dtAggregate,
    dtAggregateBuffer,
  );

  gpuCompute.setVariableDependencies(velocityVariable, [positionVariable, velocityVariable]);
  gpuCompute.setVariableDependencies(positionVariable, [positionVariable, velocityVariable]);
  gpuCompute.setVariableDependencies(aggregateVariable, [positionVariable, velocityVariable]);

  const error = gpuCompute.init();

  if (error !== null) {
    console.error(error);
  }
}

const init = async () => {
  // Create a scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x505050);

  // // Add axes helper
  // const axesHelper = new THREE.AxesHelper(5);
  // axesHelper.position.y = 1.0;
  // scene.add(axesHelper);

  // Create a camera
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 200);
  camera.position.set(0, 7.0, -10);

  // Set up audio input
  navigator.mediaDevices
    .getUserMedia({ audio: true, video: false })
    .then(function (stream) {
      const audioContext = new window.AudioContext();
      analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 32;
      analyzer.smoothingTimeConstant = 0.8;
      analyzer.minDecibels = -100;
      analyzer.maxDecibels = -5;
      mic = audioContext.createMediaStreamSource(stream);
      mic.connect(analyzer);
    })
    .catch(function (err) {
      console.error("Microphone access denied:", err);
    });

  rotator = new THREE.Object3D();
  rotator.add(camera);
  scene.add(rotator);

  // Create a terrain
  function createTerrain(
    width: number | undefined,
    height: number | undefined,
    widthSegments: number | undefined,
    heightSegments: number | undefined,
  ) {
    const geometry = new THREE.PlaneGeometry(width, height, widthSegments, heightSegments);
    const material = new THREE.MeshBasicMaterial({
      color: 0x3a7d44,
      wireframe: false,
      map: createGrassTexture(),
    });
    if (material.map) {
      material.map.magFilter = THREE.NearestFilter;
    }
    const terrain = new THREE.Mesh(geometry, material);
    terrain.rotation.x = -Math.PI / 2;
    const vertices = terrain.geometry.attributes.position.array;
    for (let i = 0; i < vertices.length; i += 3) {
      // And then we use the same when scattering grass
      vertices[i + 2] =
        Math.sin(vertices[i] / 10 - Math.PI / 2) * Math.cos(vertices[i + 1] / 10) * 5 + 5.0;
    }
    terrain.updateMatrixWorld(true);
    terrain.geometry.attributes.position.needsUpdate = true;
    terrain.geometry.computeVertexNormals();
    return terrain;
  }

  const terrain = createTerrain(50, 50, 20, 20);
  scene.add(terrain);

  // Add grass
  const grass = createGrass(10000, 50);
  grassInstances = grass.grassInstances;
  scene.add(grassInstances);

  // Generate a random pixelated texture
  function createGrassTexture() {
    const size = 128;
    const data = new Uint8Array(size * size * 4);

    for (let i = 0; i < size * size; i++) {
      const stride = i * 4;
      const shade = Math.random() * 0.5 + 0.5; // Random shade of green
      data[stride] = 34 * shade; // R
      data[stride + 1] = 139 * shade; // G
      data[stride + 2] = 34 * shade; // B
      data[stride + 3] = 255; // A
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return texture;
  }

  const gradMaterial = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    "depthWrite": false,
  });

  gradMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.time = { value: 0 };
    shader.vertexShader = "varying vec2 vUv;\nvarying vec3 vWorldPosition;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vUv = uv;
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      `,
    );

    shader.fragmentShader =
      "uniform float time;\nvarying vec2 vUv;\nvarying vec3 vWorldPosition;\n" +
      shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <logdepthbuf_fragment>",
      `#include <logdepthbuf_fragment>
      vec3 tc = vec3(0.039, 0.141, 0.447);
      vec3 mc = vec3(0.0, 0.467, 0.745);
      vec3 bc = vec3(0.529, 0.807, 0.922);
      float h = normalize(vWorldPosition).y;
      if (h > 0.0) { diffuseColor.rgb = mix(mc, tc, smoothstep(0.0, 1.0, h)); } else {
        diffuseColor.rgb = mix(bc, mc, smoothstep(-1.0, 0.0, h)); }
      `,
    );
  };

  const gradGeometry = new THREE.SphereGeometry(100, 32, 32);
  const gradMesh = new THREE.Mesh(gradGeometry, gradMaterial);
  scene.add(gradMesh);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 3.0);
  directionalLight.position.set(0, 1, 1);
  scene.add(directionalLight);
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambientLight);

  // Create a renderer.
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  // renderer.shadowMap.enabled = true;
  renderer.xr.enabled = true;
  const xrManager = new XRmanager(renderer);
  renderer["setPixelRatio"](window.devicePixelRatio);
  renderer["setSize"](window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer["domElement"]);

  // Add orbit controller
  const controls = new OrbitControls(camera, renderer["domElement"]);
  // controls["autoRotate"] = true;
  // Resize the canvas on window resize
  const adjustAspect = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    camera["aspect"] = width / height;
    camera["updateProjectionMatrix"]();
  };
  window.addEventListener("resize", function () {
    adjustAspect();
  });

  initComputeRenderer();

  function createSeedGeometry(scale = 0.3) {
    const points = [];

    points.push(new THREE.Vector2(0, 0)); // Bottom of the seed
    points.push(new THREE.Vector2(0.1, 0));
    points.push(new THREE.Vector2(0.05, 0.2)); // Top of the seed
    points.push(new THREE.Vector2(0.05, 0.6)); // Tip of the seed
    points.push(new THREE.Vector2(0.2, 0.7)); // Top of the tuft

    // Scale points
    points.forEach((point) => {
      point.multiplyScalar(scale);
    });

    const seedGeometry = new THREE.LatheGeometry(points, 4);
    seedGeometry.computeVertexNormals();
    return seedGeometry;
  }

  function createDandelion() {
    const dandelionGroup = new THREE.Group();

    // Create the stem
    const stemGeometry = new THREE.CylinderGeometry(0.05, 0.05, 1, 3);
    const stemMaterial = new THREE.MeshPhongMaterial({ color: 0x00ff00, transparent: true });
    dandelionGroup.userData.stemMaterial = stemMaterial;
    const stem = new THREE.Mesh(stemGeometry, stemMaterial);
    stem.position.y = -0.5;
    dandelionGroup.add(stem);

    // Create the flower head, using a lathe geometry
    const flowerPoints = [];
    flowerPoints.push(new THREE.Vector2(0, 0)); // Bottom of the flower
    flowerPoints.push(new THREE.Vector2(0.2, 0.1)); // Slightly wider bottom
    flowerPoints.push(new THREE.Vector2(0.0, 0.2)); // Top of the flower

    const flowerGeometry = new THREE.LatheGeometry(flowerPoints, 6);
    const flowerMaterial = new THREE.MeshPhongMaterial({
      color: 0xffff00,
      flatShading: true,
      transparent: true,
    });
    dandelionGroup.userData.flowerMaterial = flowerMaterial;
    const flowerHead = new THREE.Mesh(flowerGeometry, flowerMaterial);
    flowerHead.position.y = -0.1;
    dandelionGroup.add(flowerHead);

    const seedGeometry = createSeedGeometry();
    // Create instanced mesh for seeds
    const seedsMaterial = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    const rand = Math.ceil(Math.random() * 30) + 1;
    dandelionGroup.userData.seeds = rand;
    const instancedSeeds = new THREE.InstancedMesh(seedGeometry, seedsMaterial, rand);
    dandelionGroup.add(instancedSeeds);

    // Position and orient seeds
    const seedPositions = fibonacciSphere(rand, 0.2);
    const dummy = new THREE.Object3D();

    instancedSeeds.userData.orig = [];
    seedPositions.forEach((position, index) => {
      dummy.position.copy(position); // .add(new THREE.Vector3(0, 0.1, 0));
      // Calculate direction from origin to seed position
      const direction = position.clone().normalize();

      const quaternion = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction,
      );

      instancedSeeds.userData.orig.push({
        position: dummy.position.clone(),
        quaternion,
      });

      dummy.setRotationFromQuaternion(quaternion);
      dummy.updateMatrix();
      instancedSeeds.setMatrixAt(index, dummy.matrix);
    });

    instancedSeeds.instanceMatrix.needsUpdate = true;
    dandelionGroup.userData.instancedSeeds = instancedSeeds;
    // Add invisible sphere for raycasting
    const capsuleGeometry = new THREE.CapsuleGeometry(0.5, 0.6, 16, 16);
    const capsuleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffff00,
      visible: false,
      transparent: true,
      opacity: 0.5,
    });
    const capsule = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
    capsule.position.y = -0.25;
    dandelionGroup.add(capsule);

    return dandelionGroup;
  }

  // Function to distribute points evenly on a sphere
  function fibonacciSphere(samples = 200, radius = 0.5) {
    const points = [];
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < samples; i++) {
      const y = 1 - (i / (samples - 1)) * 2;
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = phi * i;
      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;
      points.push(new THREE.Vector3(x * radius, y * radius, z * radius));
    }
    return points;
  }

  function scatterDandelions(count: number, radius = 5) {
    for (let i = 0; i < count; i++) {
      const dandelion = createDandelion();
      const x = Math.random() * 2 * radius - radius;
      const z = Math.random() * 2 * radius - radius;
      const y = getTerrainHeight(x, z) + 1.0;
      dandelion.position.set(x, y, z);
      console.log("dandelion", dandelion.position);
      dandelions.push(dandelion);
      scene.add(dandelion);
      (window as any).dandelions = dandelions;
    }
  }

  // Helper function to get terrain height at a given point
  function getTerrainHeight(x: number | undefined, z: number | undefined) {
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
    const intersects = raycaster.intersectObject(terrain);
    return intersects.length > 0 ? intersects[0].point.y : 0;
  }

  scatterDandelions(20); // Scatter 20 dandelions

  initKnights();

  textMaker = new TextMaker();
  scene.add(textMaker.instancedMesh);
  const text1 = textMaker.addText("Hello1", new THREE.Color(0xffffff), true, true);

  // Positional audio
  const listener = new THREE.AudioListener();
  camera.add(listener);

  const createPositionalAudioPool = (listener: THREE.AudioListener) => {
    const audio = new THREE.PositionalAudio(listener);
    audio["setRefDistance"](2);
    audio["setVolume"](0.4);
    // audio["setRolloffFactor"](0.5);
    scene.add(audio);
    return audio;
  };
  // 8 positional audio sources, to be reused
  const positionalPool = {
    p: [1, 2, 3, 4].map(() => createPositionalAudioPool(listener)),
    e: [1, 2, 3, 4].map(() => createPositionalAudioPool(listener)),
  };

  textMaker = new TextMaker();
  scene.add(textMaker.instancedMesh);

  const xrSupport = await navigator.xr?.isSessionSupported("immersive-vr");
  const text = xrSupport ? "Play in VR" : `Play`;

  function intersectsFromController(i: number): THREE.Intersection[] {
    const controller = controllers[i];
    const tempMatrix = new THREE.Matrix4();
    controller["updateMatrixWorld"]();
    tempMatrix.identity()["extractRotation"](controller.matrixWorld);

    const ray = new THREE.Raycaster();
    ray.near = 0.01;
    ray.far = 0.3;
    ray["camera"] = camera;
    ray["ray"].origin["setFromMatrixPosition"](controller.matrixWorld);
    ray.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    return ray.intersectObjects(dandelions);
  }

  function handleClickOrTriggerStart(
    intersects: THREE.Intersection[],
    event?: MouseEvent | TouchEvent,
  ) {
    console.log(event, intersects);
    if (intersects.length > 0) {
      event?.preventDefault();
      const dandelion = intersects[0].object;
      if (dandelion.parent && dandelion.parent === pickedUpDandelion && selectedTarget) {
        // Temp targeting logic
        console.log("Firing dandelion");
        blowDandelion(dandelion.parent, selectedTarget);
      } else if (dandelion.parent) {
        console.log("Clicked dandelion", dandelion);
        pickUpDandelion(dandelion);
      }
    }
  }

  function addComputeCallback(name: string, callback: (buffer: Float32Array) => void) {
    if (!computeCallbacks[name]) {
      computeCallbacks[name] = [];
    }
    computeCallbacks[name].push(callback);
  }

  function removeComputeCallback(name: string, callback: (buffer: Float32Array) => void) {
    if (!computeCallbacks[name]) {
      return;
    }
    const index = computeCallbacks[name].indexOf(callback);
    if (index > -1) {
      computeCallbacks[name].splice(index, 1);
    }
  }

  function checkForParticleArrivals(dataAgg: Float32Array) {
    if (syncInProgress) {
      // console.log("syncInProgress");
      return;
    }
    unitsFound["e"] = 0;
    unitsFound["p"] = 0;

    for (let i = 0; i < dataAgg.length; i += 4) {
      // Check if the ship has collided
      if (dataAgg[i + 3] < 0) {
        // The ship has collided

        const index = Math.floor((-dataAgg[i + 3] - 0.5) * WIDTH);
        const target = targets[index];
        // Deduct points from the castle or perform other actions
        const shipOwner = dataAgg[i + 1] < 0.6005 ? "p" : "e"; // 0.6 is player, 0.601 is enemy
        if (target) {
          target.userData.lives -= 1;
          target.userData.text.updateText("0".repeat(Math.max(target.userData.lives, 0)));
          if (target.userData.lives <= 0) {
            // Target destroyed
            targets[index] = null;
            scene.remove(target);
          }
        }

        //   playRandomSoundAtPosition(shipOwner, place.position, positionalPool);
        // }

        // toReset.push(i);
      } else if (dataAgg[i + 3] > 0) {
        if (dataAgg[i + 1] < 0.6005 && dataAgg[i + 1] > 0.5995) {
          unitsFound.p++;
        } else if (dataAgg[i + 1] > 0.6005 && dataAgg[i + 1] < 0.6015) {
          unitsFound.e++;
        }
      }
    }

    // Check if the game is over
    // const planetOwners = places.map((place) => place.u.owner);
    // const pWon = planetOwners.every((owner) => [null, "p"].includes(owner)) && unitsFound.e === 0;
    // const eWon = planetOwners.every((owner) => [null, "e"].includes(owner)) && unitsFound.p === 0;
    // let gameOverText;
    // if (pWon) {
    //   gameOverText = "Victory!";
    // } else if (eWon) {
    //   gameOverText = "You lose. Darkness has fallen.";
    // }
    // if (gameOverText) {
    // gameStarted = false;
    // if (renderer.xr["isPresenting"]) {
    // xrManager.endSession();
    // adjustAspect();
    // }
    // document.getElementById("p")!.innerHTML = gameOverText;
    // togglePauseScreen();
    // }
  }

  // This we need to do every frame
  addComputeCallback("tA", (buffer) => {
    checkForParticleArrivals(buffer);
    // updateTroops();
  });

  // function handleControllers() {
  //   const session = renderer.xr["getSession"]();
  //   const currentTime = Date.now();
  //   // If gamepad horizontal is pressed, rotate camera
  //   if (session) {
  //     const inputSources = session.inputSources;
  //     for (let i = 0; i < inputSources.length; i++) {
  //       const inputSource = inputSources[i];
  //       const gamepad = inputSource.gamepad;
  //       if (gamepad) {
  //         const axes = gamepad.axes;
  //         if (axes[2] > 0.8 && currentTime - lastRotationTime > 250) {
  //           rotator.rotateY(-Math.PI / 4);
  //           lastRotationTime = currentTime;
  //         } else if (axes[2] < -0.8 && currentTime - lastRotationTime > 250) {
  //           lastRotationTime = currentTime;
  //           rotator.rotateY(Math.PI / 4);
  //         } else if (axes[3] > 0.5) {
  //           // Move forward
  //           renderer.xr.getCamera().getWorldDirection(cameraDirection);
  //           cameraDirection.applyQuaternion(rotator.quaternion);
  //           // cameraDirection.applyAxisAngle(rotator.up, rotator.rotation.y);
  //           rotator.position.addScaledVector(cameraDirection, -0.1);
  //         } else if (axes[3] < -0.5) {
  //           // Move backward
  //           renderer.xr.getCamera().getWorldDirection(cameraDirection);
  //           cameraDirection.applyQuaternion(rotator.quaternion);
  //           // cameraDirection.applyAxisAngle(rotator.up, rotator.rotation.y);
  //           rotator.position.addScaledVector(cameraDirection, 0.1);
  //         }

  //         textMaker.cameraRotation = rotator.rotation.y;
  //       }
  //     }
  //   }
  // }

  function wiggleSeeds(dandelion: THREE.Object3D, windStrength: number) {
    const tCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    const time = performance.now() * 0.001; // Convert to seconds for easier tuning
    const instancedSeeds = dandelion.userData.instancedSeeds as THREE.InstancedMesh;
    const originalData = instancedSeeds.userData.orig as {
      position: THREE.Vector3;
      quaternion: THREE.Quaternion;
    }[];
    const seedCount = dandelion.userData.instancedSeeds.count;
    const dummy = new THREE.Object3D();

    // Calculate wind direction in world space (from camera to dandelion)
    dandelion.getWorldPosition(v1);
    const windDirection = new THREE.Vector3().subVectors(v1, tCamera.position).normalize();

    // Get dandelion's world rotation
    const dandelionWorldQuaternion = new THREE.Quaternion();
    dandelion.getWorldQuaternion(dandelionWorldQuaternion);

    // Create a matrix to transform from world space to dandelion's local space
    const worldToLocal = new THREE.Matrix4()
      .makeRotationFromQuaternion(dandelionWorldQuaternion)
      .invert();

    // Transform wind direction to dandelion's local space
    const localWindDirection = windDirection.applyMatrix4(worldToLocal).normalize();

    for (let i = 0; i < seedCount; i++) {
      const originalPosition = originalData[i].position;
      const originalQuaternion = originalData[i].quaternion;

      // Base deflection angle based on wind strength (0 to π/4 radians)
      const maxDeflection = Math.PI / 4;
      const baseDeflection = windStrength * maxDeflection;

      // Add time-based waviness (smaller effect when wind is weak)
      const waviness = Math.sin(time * 2 + i * 0.1) * 0.2 * (0.2 + windStrength * 0.8);
      const totalDeflection = baseDeflection + waviness;

      // Create rotation axis perpendicular to local wind direction
      const rotationAxis = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), localWindDirection)
        .normalize();

      // Apply rotation
      dummy.position.copy(originalPosition);
      dummy.quaternion.copy(originalQuaternion);
      dummy.rotateOnAxis(rotationAxis, totalDeflection);

      // Calculate arc movement in local space
      const arcOffset = new THREE.Vector3(0, 1 - Math.cos(totalDeflection), 0).multiplyScalar(0.05);
      dummy.position.add(arcOffset);

      // Apply very slight wiggle even when wind strength is 0
      if (windStrength === 0) {
        const microWiggle = Math.sin(time * 3 + i * 0.2) * 0.001;
        dummy.rotateOnAxis(new THREE.Vector3(1, 0, 0), microWiggle);
        dummy.rotateOnAxis(new THREE.Vector3(0, 0, 1), microWiggle);
      }

      // Update the instance matrix
      dummy.updateMatrix();
      instancedSeeds.setMatrixAt(i, dummy.matrix);
    }

    // Update the instance buffer
    instancedSeeds.instanceMatrix.needsUpdate = true;
  }

  function removeDandelion(dandelion: THREE.Object3D) {
    console.log("Removing dandelion", dandelion);
    scene.remove(dandelion);
    dandelions = dandelions.filter((d) => d !== dandelion);
    dandelionToRemove = null;
  }
  // Animation loop
  function render(time: number) {
    frame++;
    controls["update"]();
    const delta = time - currentTime;
    currentTime = time;

    if (dandelionToRemove) {
      if (dandelionToRemove.userData.removeIn) {
        dandelionToRemove.userData.removeIn -= delta;
        const opacity = Math.max(0, dandelionToRemove.userData.removeIn / 1000);
        dandelionToRemove.userData.stemMaterial.opacity = opacity;
        dandelionToRemove.userData.flowerMaterial.opacity = opacity;
        if (dandelionToRemove.userData.removeIn <= 0) {
          removeDandelion(dandelionToRemove);
        }
      } else {
        dandelionToRemove.userData.removeIn = 1000;
      }
    }
    (grassInstances.material as THREE.ShaderMaterial).uniforms.time.value =
      performance.now() / 1000;

    if (analyzer) {
      analyzer.getByteFrequencyData(fftArray);
    }
    // In VR, if user moves outside of the play area, reset the camera
    if (renderer.xr.isPresenting) {
      const camera = renderer.xr.getCamera();
      camera.getWorldPosition(v1);
      v1.y = 0;
      if (v1.length() > 5) {
        const baseReferenceSpace = renderer.xr.getReferenceSpace();
        if (baseReferenceSpace) {
          // Set the reference space with such an offset that the camera is reset
          const transform = new XRRigidTransform(v1, undefined);
          const referenceSpace = baseReferenceSpace.getOffsetReferenceSpace(transform);
          renderer.xr.setReferenceSpace(referenceSpace);
        }
      }
    }
    if (pickedUpDandelion) {
      // wiggleSeeds(pickedUpDandelion, 2); //Math.max(0, Math.sin(time / 1000)));
      selectedTarget = targeting();
    }
    if (analyzer && pickedUpDandelion) {
      // Only use the higher frequencies
      // console.log(dataArray);
      const higher = fftArray.slice(4, 32);
      const volume = Math.max(...higher) / 255;
      text1?.updateText(`Volume: ${volume.toFixed(3)}`);
      // Smooth very smoothly with oldVolume
      oldVolume = oldVolume * 0.9 + volume * 0.1;
      wiggleSeeds(pickedUpDandelion, oldVolume * 4);

      if (volume > blowingThreshold && selectedTarget) {
        // Blow dandelion
        blowDandelion(pickedUpDandelion, selectedTarget);
        oldVolume = 0;
      }
    }

    moveEnemies();

    // handleControllers();
    if (gameStarted) {
      if (frame % 10 === 0) {
        syncWithGPU();
        // updateEnemyPositionsInTexture();
      }
      lastGenerationTime = lastGenerationTime || Date.now();
      gpuCompute.compute(computeCallbacks);

      const tP = gpuCompute.getCurrentRenderTarget(positionVariable)["texture"];
      const tV = gpuCompute.getCurrentRenderTarget(velocityVariable)["texture"];

      knightUniforms["tP"].value = tP;
      knightUniforms["tV"].value = tV;
      // updatePointing();
    }
    renderer.render(scene, camera);
  }
  renderer["setAnimationLoop"](render);

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function getPointerPosition(event: PointerEvent) {
    return { x: event.clientX, y: event.clientY };
  }

  function onPointerDown(event: PointerEvent) {
    const position = getPointerPosition(event);
    mouse.x = (position.x / window.innerWidth) * 2 - 1;
    mouse.y = -(position.y / window.innerHeight) * 2 + 1;

    raycaster["setFromCamera"](mouse, camera);
    const intersects = raycaster["intersectObjects"](dandelions);

    handleClickOrTriggerStart(intersects, event);
  }

  function onPointerUp(event: PointerEvent) {
    // if (!isDragging) return;

    const position = getPointerPosition(event);
    mouse.x = (position.x / window.innerWidth) * 2 - 1;
    mouse.y = -(position.y / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(dandelions);

    // handleClickOrTriggerEnd(intersects, event);
  }

  function pickUpDandelion(dandelion: THREE.Object3D, controllerIndex?: number) {
    // Add dandelion to the controller
    if (dandelionToRemove) {
      removeDandelion(dandelionToRemove);
    }
    if (dandelion.parent) {
      if (controllerIndex !== undefined) {
        // in VR
        controllers[controllerIndex].add(dandelion.parent);
        dandelion.parent.position.set(0, 0.5, -0.1);
      }
      // With a mouse, we want to move the dandelion to the center of the screen, at a fixed distance
      else {
        const center = new THREE.Vector3(0, 2, 0);
        // center.applyQuaternion(camera.quaternion);
        // center.add(camera.position);
        dandelion.parent.position.copy(center);
        // scene.add(dandelion.parent);
      }
      console.log("Picked up dandelion", dandelion);
      pickedUpDandelion = dandelion.parent;
    }
  }

  function initControllers() {
    // Handle controllers for WebXR
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr["getController"](i);
      rotator.add(controller);

      // Create a visual representation for the controller: a cube
      const geometry = new THREE.BoxGeometry(0.025, 0.025, 0.2);
      const material = new THREE.MeshStandardMaterial({ color: colors.player });

      const cube = new THREE.Mesh(geometry, material);
      controller.add(cube); // Attach the cube to the controller

      const line = new THREE.Line();
      line.geometry["setFromPoints"]([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      line.material = new THREE.LineBasicMaterial({ color: colors.player });
      line.scale.z = 5;
      controller.add(line);

      controllers.push(controller);
      controller.addEventListener("selectstart", () => onSelectStart(i));
      controller.addEventListener("selectend", () => onSelectEnd(i));
    }
  }

  function onSelectStart(i: number) {
    console.log("select start");
    const intersects = intersectsFromController(i);
    // handleClickOrTriggerStart(intersects);
    if (intersects.length > 0) {
      pickUpDandelion(intersects[0].object, i);
    }

    // controllerLock = i;
  }

  function onSelectEnd(i: number) {
    // console.log("select end", startPlace, intersectedPlace);
    // endPlace = intersectedPlace;
    const intersects = intersectsFromController(i);
    // handleClickOrTriggerEnd(intersects);

    // controllerLock = null;
  }

  async function startGame() {
    console.log("Game started");
    // TODO: Maybe for 13?
    // (velocityVariable.material as any).uniforms.d.value = difficulty;
    // createTextSprite("Game started!", false, true);
    if (xrSupport) {
      await xrManager.startSession();
      renderer.xr.setFoveation(0);
      initControllers();
    }
    const music = new Music();
    music.start();

    document.getElementById("s")?.remove();
    controls.autoRotate = false;
    gameStarted = true;

    window.addEventListener("pointerdown", onPointerDown, false);
    window.addEventListener("pointerup", onPointerUp, false);

    document.addEventListener("keydown", (e) => {
      if (e.key === "p") {
        gameStarted = !gameStarted;
        togglePauseScreen();
      }
    });
    (window as any).scene = scene;

    // Simple AI sends attacks high priority targets and low resistance targets
    // setTimeout(doAI, Math.random() * 5000 - difficulty * 1000);
  }

  // function doAI() {
  //   // Random e owned castle
  //   const eCastles = places.filter((p) => p.u.owner === "e");
  //   const otherCastles = places.filter((p) => !eCastles.includes(p));
  //   // const pCastles = places.filter((p) => p.u.owner === "p");

  //   // Sort by a combination of size and troops, giving priority to larger places with fewer troops.
  //   const highValueTargets = otherCastles.sort(
  //     (a, b) => b.u.size / (b.u.troops + 1) - a.u.size / (a.u.troops + 1),
  //   );
  //   const startPlace = eCastles[Math.floor(Math.random() * eCastles.length)];
  //   // Prioritize attacking places based priority, but attack random ones based on level
  //   const randomness = Math.random() < difficulty / 3;
  //   const endPlace = randomness
  //     ? highValueTargets[0]
  //     : otherCastles[Math.floor(Math.random() * otherCastles.length)];

  //   if (startPlace && endPlace && startPlace !== endPlace) {
  //     sendFleetFromPlaceToPlace(startPlace, endPlace);
  //   }
  //   setTimeout(doAI, aiDelay());
  // }

  function togglePauseScreen() {
    lastGenerationTime = Date.now();
    const style = gameStarted ? "none" : "block";
    document.getElementById("p")!.style.display = style;
  }

  const button = document.getElementById("b");
  if (button) {
    button.innerHTML = text;
    button.addEventListener("click", startGame);
  }

  function initKnights() {
    const baseGeometry = createSeedGeometry();
    // baseGeometry.scale(0.3, 0.3, 0.3);
    baseGeometry["rotateX"](-Math.PI / 2);
    const instancedGeometry = new THREE.InstancedBufferGeometry();
    instancedGeometry["index"] = baseGeometry["index"];
    instancedGeometry.attributes.position = baseGeometry.attributes.position;
    instancedGeometry.attributes.uv = baseGeometry.attributes.uv;
    instancedGeometry.attributes.normal = baseGeometry.attributes.normal;
    instancedGeometry["instanceCount"] = PARTICLES;
    const uvs = new Float32Array(PARTICLES * 2);
    let p = 0;

    for (let j = 0; j < WIDTH; j++) {
      for (let i = 0; i < WIDTH; i++) {
        uvs[p++] = i / (WIDTH - 1);
        uvs[p++] = j / (WIDTH - 1);
      }
    }

    instancedGeometry.setAttribute("dtUv", new THREE.InstancedBufferAttribute(uvs, 2));
    knightUniforms = {
      "tP": { value: null },
      "tV": { value: null },
      "eC": { value: colors.enemy },
      "pC": { value: colors.player },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: knightUniforms,
      vertexShader: knightVertex,
      fragmentShader: knightFragment,
      // transparent: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(instancedGeometry, material, PARTICLES);
    mesh["frustumCulled"] = false;
    scene.add(mesh);
  }

  function createEnemy() {
    const geometry = new THREE.SphereGeometry(0.5, 3, 4);
    const material = new THREE.MeshPhongMaterial({
      color: 0xff0000,
      flatShading: true,
    });
    const enemy = new THREE.Mesh(geometry, material);

    const angle = Math.random() * Math.PI * 2;
    const radius = 25;
    enemy.position.set(
      Math.cos(angle) * radius,
      -5, // Start below the ground
      Math.sin(angle) * radius,
    );

    const text = textMaker.addText("", new THREE.Color(0xff0000), true, true);
    text?.setPosition(enemy.position.x, enemy.position.y + 1, enemy.position.z);
    text?.setScale(10.0);
    text?.updateText("12345678");
    enemy.userData.text = text;
    enemy.userData.type = "enemy";
    enemy.userData.lives = 6;
    scene.add(enemy);

    // Find a random empty spot in targets array and add the enemy
    const emptySpotsIndexes = targets.map((t, i) => (t ? null : i)).filter((i) => i !== null);
    const index = emptySpotsIndexes[Math.floor(Math.random() * emptySpotsIndexes.length)];
    if (index) {
      targets[index] = enemy;
    } else {
      console.log("No empty spots for enemy");
    }
  }

  // function syncText(target: THREE.Mesh) {
  //   const text = target.userData.text as TextInstance;
  //   text.setPosition(target.position.x, target.position.y + 1, target.position.z);
  //   if (target.userData.currentlyTargeted && pickedUpDandelion) {
  //     text.updateText("Target");
  //   } else if (pickedUpDandelion) {
  //   }
  // }

  function moveEnemies() {
    const enemies = targets.filter((t) => t && t.userData.type === "enemy") as THREE.Mesh[];
    if (Math.random() < 0.02 && enemies.length < 20) createEnemy();

    enemies.forEach((sphere, i) => {
      // Update text
      const text = sphere.userData.text as TextInstance;
      // text.updateText(sphere.position.x.toFixed(2) + ", " + sphere.position.z.toFixed(2));
      text.setPosition(sphere.position.x, sphere.position.y + 1, sphere.position.z);

      // Rise slowly
      if (sphere.position.y < 10) {
        sphere.position.y += (10 - sphere.position.y) * 0.01;
      }

      if (Math.random() < 0.11) {
        // addUnitsToTexture(10, sphere, places[0], "e");
      }

      // Move towards center
      const directionToCenter = new THREE.Vector3()
        .subVectors(new THREE.Vector3(0, sphere.position.y, 0), sphere.position)
        .normalize();
      sphere.position.add(directionToCenter.multiplyScalar(0.01));

      // Remove if too close to center
      if (new THREE.Vector2(sphere.position.x, sphere.position.z).length() < 0.5) {
        targets[targets.indexOf(sphere)] = null;
        sphere.userData.text.remove();
        scene.remove(sphere);
        // enemies = enemies.filter((s) => s !== sphere);
        // places = places.filter((p) => p !== sphere);
      }
    });
  }
  // function changePlaces() {
  //   const dtPosition = gpuCompute.createTexture();
  //   const dtVelocity = gpuCompute.createTexture();

  //   fillTextures(dtPosition, dtVelocity);
  //   const rt = gpuCompute.getCurrentRenderTarget(positionVariable);
  //   // gpuCompute.renderTexture(dtPosition, positionVariable.renderTargets[0]);
  //   gpuCompute.renderTexture(dtPosition, rt);
  //   dtVelocity.needsUpdate = true;
  //   const rtv = gpuCompute.getCurrentRenderTarget(velocityVariable);
  //   gpuCompute.renderTexture(dtVelocity, rtv);
  // }

  // Example
  // const unit = {
  //   pos: dummyVec.clone(),
  //   rot: dummyVec, // temp
  //   start: dandelion.position.clone(),
  //   end: target,
  //   owner: "p",
  // };

  // This takes the number of seeds of a picked dandelion, and adds them to the data texture
  function blowDandelion(dandelion: THREE.Object3D, target: THREE.Mesh) {
    const dummy = new THREE.Object3D();
    const dummyVec = new THREE.Vector3();
    const dummyMat4 = new THREE.Matrix4();
    const units: Unit[] = [];
    for (let i = 0; i < dandelion.userData.seeds; i++) {
      dummy.parent = dandelion;
      dandelion.userData.instancedSeeds.getMatrixAt(i, dummyMat4);
      dummyMat4.decompose(dummy.position, dummy.quaternion, dummy.scale);
      // console.log("dummy q", dummy.quaternion);
      // console.log("dummy pos", dummy.position);
      // dummy.matrix.copy(dummyMat4);
      // dummy.matrixAutoUpdate = false;
      // dummy.updateMatrixWorld(true);
      dummy.getWorldPosition(dummyVec);
      // dummy.position.setFromMatrixPosition(dummy.matrix);
      const unit = {
        pos: dummyVec.clone(),
        rot: dummyVec, // temp
        start: targets[0] as THREE.Mesh,
        target,
        owner: "p" as "p" | "e",
      };
      // dummy.getWorldDirection(dummyVec);
      // const webglDirection = new THREE.Vector3(dummyVec.x, dummyVec.y, dummyVec.z);
      const webglDirection = new THREE.Vector3(dummyVec.x, dummyVec.y, dummyVec.z);
      // Then transform it by a quaternion
      webglDirection.normalize();
      webglDirection.applyQuaternion(dummy.quaternion);
      // webglDirection.normalize().multiplyScalar(10);
      // dummyVec.multiplyScalar(0.1);

      unit.rot = webglDirection;
      units.push(unit);
    }
    unitQueue.push(...units);
    console.log(units.length, "units added to queue");

    // Move it somewhere far below
    // console.log("Blowing dandelion", dandelion.userData.seeds);
    console.log("target is at", target.position);
    dandelion.userData.seeds = 0;
    pickedUpDandelion = null;
    dandelionToRemove = dandelion;
    syncLivesText(target);
  }

  function syncLivesText(target: THREE.Mesh) {
    const text = target.userData.text as TextInstance;
    text.updateText("0".repeat(Math.max(target.userData.lives, 0)));
  }

  function targeting() {
    let target: THREE.Mesh | null = null;
    if (pickedUpDandelion) {
      // Find the target by taking the closest place in the
      // direction from the camera to the dandelion
      let tCamera = camera;

      if (renderer.xr.isPresenting) {
        tCamera = renderer.xr.getCamera() as THREE.PerspectiveCamera;
        tCamera.getWorldPosition(v1);
      } else {
        tCamera.getWorldPosition(v1);
      }

      pickedUpDandelion.getWorldPosition(v2);
      const direction = new THREE.Vector3().subVectors(v2, v1).normalize();

      const raycaster = new THREE.Raycaster(v2, direction);

      let minDist = 1000;
      targets.forEach((targetCandidate) => {
        if (!targetCandidate) return;
        targetCandidate.userData.currentTarget = false;
        if (!targetCandidate) return;
        // enemies are enemy ships
        const distance = raycaster.ray.distanceToPoint(targetCandidate.position);
        const normalizedDistance = Math.min(distance / 15, 1); // Normalize to [0, 1]
        syncLivesText(targetCandidate);
        if (distance < minDist) {
          minDist = distance;
          target = targetCandidate;
        }
        (targetCandidate.material as THREE.MeshBasicMaterial).color.setRGB(
          1 - normalizedDistance,
          normalizedDistance,
          0,
        );
      });
      if (target) {
        (target as THREE.Mesh).userData.currentTarget = true;
        (target as THREE.Mesh).userData.text.updateText("Target");
      }

      if (target !== null) {
        return target;
      }
    }
    return null;
  }

  // For example:
  // encodeTwoFloatsAsOne(1.23, 2.34) = 12302.340
  function encodeFloats(a: number, b: number) {
    // Multiply first float by 100 and floor it
    const encodedA = Math.floor(a * 1000);
    const bSign = Math.sign(b);
    // Multiply second float by 10 to preserve one decimal place
    const encodedB = Math.abs(b);
    // Combine the two values
    return bSign * (encodedA * 10 + encodedB);
  }

  function syncWithGPU() {
    if (syncInProgress) {
      console.log("Sync in progress");
      return;
    }

    const dtPosition = gpuCompute.createTexture();
    const dtVelocity = gpuCompute.createTexture();
    let slotsFound = 0;
    const slots: number[] = [];

    const positionCallback = (buffer: Float32Array) => {
      // console.log("Position callback");
      dtPosition.image.data.set(buffer);
      const posArray = dtPosition.image.data;

      for (let i = 0; i < targets.length; i++) {
        if (targets[i] === null) continue;
        const index = i * 4;
        posArray[index] = targets[i]!.position.x;
        posArray[index + 1] = targets[i]!.position.y;
        posArray[index + 2] = targets[i]!.position.z;
        posArray[index + 3] = 0.1; // enemy flying "castle"
      }

      for (let i = 0; i < slots.length; i++) {
        const index = slots[i];
        const unit = unitQueue[i];
        // console.log("Adding unit", unit.pos);
        if (unit.owner === "p") {
          posArray[index] = unit.pos.x;
          posArray[index + 1] = unit.pos.y;
          posArray[index + 2] = unit.pos.z;
          posArray[index + 3] = 0.6; // ship type
        } else {
          posArray[index] = unit.pos.x;
          posArray[index + 1] = unit.pos.y;
          posArray[index + 2] = unit.pos.z;
          posArray[index + 3] = 0.601; // ship type
        }
      }
      removeComputeCallback("tP", positionCallback);
      dtPosition.needsUpdate = true;

      const rt = gpuCompute.getCurrentRenderTarget(positionVariable);
      gpuCompute.renderTexture(dtPosition, rt);
      dtVelocity.needsUpdate = true;
      const rtv = gpuCompute.getCurrentRenderTarget(velocityVariable);
      gpuCompute.renderTexture(dtVelocity, rtv);

      syncInProgress = false;

      // startPlace.u.troops -= slots.length / 2;
      if (slots.length > 0) {
        slots.length = 0;
        unitQueue.length = 0;
        console.log("Unit launch done");
      }
      if (dandelionToRemove) {
        if (dandelionToRemove.userData.instancedSeeds.count) {
          console.log(dandelionToRemove.uuid, "instancedSeeds = 0");
          dandelionToRemove.userData.instancedSeeds.count = 0;
        }
      }
    };

    const velocityCallback = (buffer: Float32Array) => {
      syncInProgress = true;
      // console.log("Velocity callback");
      dtVelocity.image.data.set(buffer);
      const velArray: Uint8ClampedArray = dtVelocity.image.data;
      const livingTargets = targets.filter((t) => t !== null);
      // Sort by distance to 0, 0, 0
      livingTargets.sort((a, b) => {
        const distA = a!.position.length();
        const distB = b!.position.length();
        return distA - distB;
      });

      const closestTarget = livingTargets[0];
      const closestTargetIndex = targets.indexOf(closestTarget);
      for (let i = 0; i < velArray.length; i += 4) {
        const unit = unitQueue[slotsFound];

        if (unit && slotsFound < unitQueue.length + 1) {
          const targetId = targets.indexOf(unit.target);
          const dtTarget = (targetId + 0.5) / WIDTH + 0.5;

          const startId = targets.indexOf(unit.start);
          const dtStart = (startId + 0.5) / WIDTH + 0.5;

          const encoded = encodeFloats(dtStart, dtTarget);

          // // Only allow 1/2 of total units per p
          // if (unitsFound[unit.owner] + slotsFound >= PARTICLES / 2 - 64) {
          //   break;
          // }
          // Check if the slot is empty
          if (velArray[i + 3] === 0) {
            // this is 1.0 or mass for non-units
            // Update the slot
            velArray[i] = unit.rot.x;
            velArray[i + 1] = unit.rot.y;
            velArray[i + 2] = unit.rot.z;
            velArray[i + 3] = encoded; // target castle id
            slotsFound++;
            slots.push(i);
          }
          // if (slotsFound > unitQueue.length - 1) {
          //   break;
          // }
        }
        // See if units are without target
        const dtTarget = velArray[i + 3] % 10;
        const targetId = Math.floor((dtTarget - 0.5) * WIDTH);
        if (dtTarget > 0 && !targets[targetId] && i > WIDTH * 4) {
          const dtTarget = (closestTargetIndex + 0.5) / WIDTH + 0.5;
          const dtStart = 0 + 0.5 / WIDTH + 0.5;
          const encoded = encodeFloats(dtStart, dtTarget);
          // redirect to another random target
          velArray[i + 3] = encoded;
        }
      }

      if (slotsFound > 0) {
        console.log("Launched", slots.length, "units to", unitQueue[0].target.position);
      }
      if (slotsFound < Math.floor(unitQueue.length)) {
        console.warn(`Only ${slotsFound} slots were found (needed ${unitQueue.length}).`);
      }
      removeComputeCallback("tV", velocityCallback);
      addComputeCallback("tP", positionCallback);
    };

    if (unitQueue.length > 0 || frame % 10 === 0) {
      // console.log("Adding compute callbacks");
      addComputeCallback("tV", velocityCallback);
    }
  }
};

init();
