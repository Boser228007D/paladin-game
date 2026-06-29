import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { io } from 'socket.io-client';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x5ca8df);
scene.fog = new THREE.Fog(0x5ca8df, 150, 1200);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 5000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Third Person Camera State
let cameraYaw = 0;
let cameraPitch = 0.3; 
const cameraRadius = 5;
const cameraTarget = new THREE.Vector3(0, 0.9, 0);

// Pointer Lock setup
document.addEventListener('keydown', (e) => {
    // Press 'C' or 'Esc' to toggle pointer lock (Esc is native)
    if (e.code === 'KeyC') {
        if (document.pointerLockElement === document.body) {
            document.exitPointerLock();
        } else {
            document.body.requestPointerLock();
        }
    }
});

document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement === document.body) {
        cameraYaw -= event.movementX * 0.002;
        cameraPitch += event.movementY * 0.002;
        
        // Clamp pitch to avoid flipping over or looking from straight down/up
        cameraPitch = Math.max(-0.5, Math.min(Math.PI / 2 - 0.1, cameraPitch));
    }
});

// Day/Night cycle - 1 cycle = 8 minutes (480 seconds: 5m day, 1m eve, 2m night)
const DAY_DURATION = 480;
let dayTime = 0;

const sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
sunLight.shadow.camera.top = 120;
sunLight.shadow.camera.bottom = -120;
sunLight.shadow.camera.left = -120;
sunLight.shadow.camera.right = 120;
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 600;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);

const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x3d2b1f, 0.5);
hemiLight.position.set(0, 1, 0);
scene.add(hemiLight);

// Ambient for night visibility (moonlight)
const ambientLight = new THREE.AmbientLight(0x3355aa, 0.25);
scene.add(ambientLight);

// Sky color palette
const skyColors = {
    night:   new THREE.Color(0x020412),
    dawn:    new THREE.Color(0xf07030),
    morning: new THREE.Color(0x87ceeb),
    noon:    new THREE.Color(0x5ca8df),
    dusk:    new THREE.Color(0xf06020),
};

// Clouds
const cloudGroup = new THREE.Group();
const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
for (let i = 0; i < 40; i++) {
    const g = new THREE.Group();
    const numPuffs = 4 + Math.floor(Math.random() * 4);
    for (let p = 0; p < numPuffs; p++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(8 + Math.random() * 10, 6, 6), cloudMat);
        puff.position.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 20);
        puff.scale.set(1 + Math.random(), 0.5 + Math.random() * 0.5, 1 + Math.random());
        g.add(puff);
    }
    g.position.set(
        (Math.random() - 0.5) * 1200,
        120 + Math.random() * 60,
        (Math.random() - 0.5) * 1200
    );
    cloudGroup.add(g);
}
scene.add(cloudGroup);

let serverTimeOffset = 0;
function updateDayNight(delta) {
    const absoluteTimeMs = Date.now() - serverTimeOffset;
    dayTime = (absoluteTimeMs / 1000) % DAY_DURATION;
    const t_real = dayTime / DAY_DURATION; // 0..1 over 8 minutes

    // Map linear time to sun time:
    // Day (5m) = 0 to 5/8  --> maps to sun t 0.0 to 0.5 (Sunrise to Sunset)
    // Eve (1m) = 5/8 to 6/8 --> maps to sun t 0.5 to 0.65 (Dusk to Night)
    // Night (2m) = 6/8 to 1.0 --> maps to sun t 0.65 to 1.0 (Night to Dawn)
    let t_sun;
    if (t_real < 0.625) {
        t_sun = (t_real / 0.625) * 0.5;
    } else if (t_real < 0.75) {
        const f = (t_real - 0.625) / 0.125;
        t_sun = 0.5 + f * 0.15;
    } else {
        const f = (t_real - 0.75) / 0.25;
        t_sun = 0.65 + f * 0.35;
    }

    const angle = t_sun * Math.PI * 2; // 0..2PI

    // Sun position on a big arc
    const sunRadius = 300;
    sunLight.position.set(
        Math.cos(angle) * sunRadius,
        Math.sin(angle) * sunRadius,
        80
    );

    // Sun intensity: 0 at night, 1.5 at noon
    const elevation = Math.sin(angle); // -1..1
    const sunIntensity = Math.max(0, elevation); // only when above horizon
    sunLight.intensity = sunIntensity * 1.5;

    // Sky & fog color interpolation based on t_sun
    let skyColor;
    if (t_sun < 0.1) {
        // Dawn -> Morning (0 to 0.1)
        skyColor = skyColors.dawn.clone().lerp(skyColors.morning, t_sun / 0.1);
    } else if (t_sun < 0.25) {
        // Morning -> Noon (0.1 to 0.25)
        const f = (t_sun - 0.1) / 0.15;
        skyColor = skyColors.morning.clone().lerp(skyColors.noon, f);
    } else if (t_sun < 0.4) {
        // Noon -> Afternoon/Morning (0.25 to 0.4)
        const f = (t_sun - 0.25) / 0.15;
        skyColor = skyColors.noon.clone().lerp(skyColors.morning, f);
    } else if (t_sun < 0.5) {
        // Afternoon -> Dusk (0.4 to 0.5)
        const f = (t_sun - 0.4) / 0.1;
        skyColor = skyColors.morning.clone().lerp(skyColors.dusk, f);
    } else if (t_sun < 0.6) {
        // Dusk -> Night (0.5 to 0.6)
        const f = (t_sun - 0.5) / 0.1;
        skyColor = skyColors.dusk.clone().lerp(skyColors.night, f);
    } else if (t_sun < 0.9) {
        // Deep Night (0.6 to 0.9)
        skyColor = skyColors.night.clone();
    } else {
        // Night -> Dawn (0.9 to 1.0)
        const f = (t_sun - 0.9) / 0.1;
        skyColor = skyColors.night.clone().lerp(skyColors.dawn, f);
    }

    scene.background = skyColor;
    scene.fog.color.copy(skyColor);

    // Hemisphere: sky top follows sky color, ground darkens at night
    hemiLight.color.copy(skyColor);
    hemiLight.groundColor.setHSL(0.1, 0.3, 0.05 + sunIntensity * 0.15);
    hemiLight.intensity = 0.3 + sunIntensity * 0.4;

    // Ambient glow at night (moonlight) - always at least 0.25 so it's never pitch black
    ambientLight.intensity = 0.25 + Math.max(0, 0.05 - sunIntensity * 0.05);
    ambientLight.color.setHex(sunIntensity > 0.1 ? 0xffffff : 0x3355aa); // Blue moonlight at night

    // Sun light color: warm orange at horizon, white at peak
    const warmth = Math.max(0, 1 - elevation * 2);
    sunLight.color.setRGB(1, 1 - warmth * 0.3, 1 - warmth * 0.6);

    // Drift clouds slowly
    cloudGroup.position.x += delta * 2;
    if (cloudGroup.position.x > 600) cloudGroup.position.x = -600;

    // Cloud color: white by day, gray-blue at night
    const cloudBrightness = 0.3 + sunIntensity * 0.7;
    cloudMat.color.setRGB(cloudBrightness, cloudBrightness, cloudBrightness * 1.1);

    // Animate map fire lights flicker
    scene.traverse(obj => {
        if (obj.isPointLight && obj.userData.isFireLight) {
            const flicker = 0.85 + Math.sin(Date.now() * 0.017 + obj.id) * 0.1 + Math.random() * 0.05;
            obj.intensity = 2.0 * flicker;
        }
    });
}

// Load User's Map
let mapLoaded = false;
const mapMeshes = [];

function getValidSpawn() {
    for (let radius = 0; radius < 200; radius += 5) {
        const steps = radius === 0 ? 1 : 8;
        for (let i = 0; i < steps; i++) {
            const angle = (i / steps) * Math.PI * 2;
            const dx = Math.cos(angle) * radius;
            const dz = Math.sin(angle) * radius;
            const ray = new THREE.Raycaster(new THREE.Vector3(dx, 1000, dz), new THREE.Vector3(0, -1, 0));
            ray.firstHitOnly = true;
            const hits = ray.intersectObjects(mapMeshes, false);
            if (hits.length > 0) {
                return hits[0].point;
            }
        }
    }
    return new THREE.Vector3(0, 50, 0); // Fallback
}

const gltfLoader = new GLTFLoader();
gltfLoader.load('/assets/Map/scene.gltf', (gltf) => {
    const mapModel = gltf.scene;
    
    mapModel.scale.setScalar(60);
    mapModel.updateMatrixWorld(true);

    let firePos = null;

    mapModel.traverse((child) => {
        if (child.isMesh) {
            child.receiveShadow = true;
            child.castShadow = true;
            
            if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                let matName = '';
                mats.forEach(mat => {
                    matName += (mat.name || '').toLowerCase() + ' ';
                });
                
                if (matName.includes('right_fire') || matName.includes('fire') || matName.includes('flame')) {
                    // Add a warm point light at fire sources
                    const fireLight = new THREE.PointLight(0xff6622, 2.5, 20);
                    child.geometry.computeBoundingBox();
                    const fireCenter = new THREE.Vector3();
                    child.geometry.boundingBox.getCenter(fireCenter);
                    child.localToWorld(fireCenter);
                    fireLight.position.copy(fireCenter);
                    fireLight.position.y += 1.0;
                    scene.add(fireLight);
                    // Animate fire light every frame via updateDayNight
                    fireLight.userData.isFireLight = true;
                }
                
                if (matName.includes('geralt') && !firePos) {
                    child.geometry.computeBoundingBox();
                    firePos = new THREE.Vector3();
                    child.geometry.boundingBox.getCenter(firePos);
                    child.localToWorld(firePos);
                }
                
                // Filter out bushes, NPCs, and gates from collision using names
                const passables = ['plant', 'tree', 'oak', 'chicken', 'cock', 'people', 'lady', 'archer', 'triss', 'dog', 'sabrina', 'girl', 'princess', 'queen', 'king', 'man', 'weed', 'grass', 'bush', 'warrior', 'geralt', 'panorama', 'sky', 'gate', 'chain', '6112010a', 'oct_20139', 'file_3_114', 'laundry', 'wheel', 'knight'];
                const isPassable = passables.some(p => matName.includes(p));

                mats.forEach(mat => {
                    // Visual fix: alphaTest for cutouts (PNGs)
                    const noAlphaFix = ['water', 'fire', 'smoke', 'glass', 'cloud', 'dirt', 'path'];
                    const needsAlphaFix = (mat.transparent || mat.alphaMode === 'BLEND') && !noAlphaFix.some(p => matName.includes(p));
                    
                    if (needsAlphaFix) {
                        mat.transparent = true;
                        // Higher cutoff for billboard characters to hide shadow rectangles
                        const isCharacter = ['people', 'geralt', 'geralt_full', 'warrior', 'knight', 'archer', 'triss', 'lady', 'princess', 'queen', 'king', 'sabrina', 'girl', 'tavern', 'jester', 'pedo'].some(p => matName.includes(p));
                        mat.alphaTest = isCharacter ? 0.8 : 0.5;
                        mat.depthWrite = true;
                        mat.needsUpdate = true;
                    }
                });
                
                // Hide low-poly sky domes and panoramas from the map, we use real sky
                if (matName.includes('panorama') || matName.includes('sky') || matName.includes('60_panoramas')) {
                    child.visible = false;
                }
                
                if (!isPassable) {
                    child.geometry.computeBoundsTree(); // Generate BVH
                    mapMeshes.push(child);
                }
            }
        }
    });
    scene.add(mapModel);
    
    // Initial snap to ground if player is already loaded
    if (model && mapMeshes.length > 0) {
        let spawn;
        if (firePos) {
            // Raycast down from fire position to find exact ground
            const ray = new THREE.Raycaster(new THREE.Vector3(firePos.x, 1000, firePos.z), new THREE.Vector3(0, -1, 0));
            ray.firstHitOnly = true;
            const hits = ray.intersectObjects(mapMeshes, false);
            if (hits.length > 0) {
                spawn = hits[0].point;
            } else {
                spawn = getValidSpawn();
            }
        } else {
            spawn = getValidSpawn();
        }
        model.position.copy(spawn);
        velocity.y = 0;
    }
    mapLoaded = true;
});

let mixer;
let model;
let torchLight = null;
let currentAction = null;
const actions = {};
const clock = new THREE.Clock();

const speed = 2.5;
const velocity = new THREE.Vector3();

// State
const state = {
    moveForward: false,
    moveBackward: false,
    moveLeft: false,
    moveRight: false,
    isAttacking: false,
    isSprinting: false,
    isBlocking: false,
    blockCooldown: false,
    isJumping: false,
    isGrounded: true,
};

// Load Model
const loader = new FBXLoader();
loader.setPath('/assets/');

loader.load('Paladin WProp J Nordstrom.fbx', (object) => {
    model = object;
    model.scale.setScalar(0.006);
    mixer = new THREE.AnimationMixer(model);

    model.traverse((child) => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });

    scene.add(model);
    


    
    // Initial snap to ground if map is already loaded
    if (mapMeshes.length > 0) {
        const spawn = getValidSpawn();
        model.position.copy(spawn);
        velocity.y = 0;
    }

    // Load Animations
    loadAnimation('sword and shield idle.fbx', 'idle', () => {
        loadAnimation('sword and shield walk.fbx', 'walk', () => {
            loadAnimation('sword and shield slash.fbx', 'attack', () => {
                loadAnimation('sword and shield run.fbx', 'run', () => {
                    loadAnimation('sword and shield block idle.fbx', 'block', () => {
                        loadAnimation('sword and shield jump.fbx', 'jump', () => {
                            // All loaded
                            actions['idle'].play();
                            currentAction = actions['idle'];
                        });
                    });
                });
            });
        });
    });
});

function loadAnimation(file, name, callback) {
    loader.load(file, (anim) => {
        // Remove ALL root motion / position tracks to prevent teleporting bugs
        anim.animations[0].tracks = anim.animations[0].tracks.filter(track => {
            return !track.name.includes('.position');
        });

        const action = mixer.clipAction(anim.animations[0]);
        if (name === 'attack' || name === 'jump') {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
        }
        actions[name] = action;
        if (callback) callback();
    });
}

function fadeToAction(name, duration) {
    const previousAction = currentAction;
    const activeAction = actions[name];

    if (!activeAction) return; // Prevent TypeError if action isn't loaded yet

    if (previousAction !== activeAction) {
        if (previousAction) {
            previousAction.fadeOut(duration);
        }
        
        activeAction
            .reset()
            .setEffectiveTimeScale(1)
            .setEffectiveWeight(1)
            .fadeIn(duration)
            .play();

        currentAction = activeAction;
    }
}

// Input Handlers
document.addEventListener('contextmenu', e => e.preventDefault());

document.addEventListener('keydown', (event) => {
    switch (event.code) {
        case 'KeyW': state.moveForward = true; break;
        case 'KeyA': state.moveLeft = true; break;
        case 'KeyS': state.moveBackward = true; break;
        case 'KeyD': state.moveRight = true; break;
        case 'ShiftLeft': state.isSprinting = true; break;
        case 'Space': 
            if (!state.isJumping && !state.isAttacking && !state.isBlocking && state.isGrounded) {
                state.isJumping = true;
                state.isGrounded = false;
                velocity.y = 8.0; // Reduced jump strength
                updateAnimationState();
            }
            break;
    }
});

document.addEventListener('keyup', (event) => {
    switch (event.code) {
        case 'KeyW': state.moveForward = false; break;
        case 'KeyA': state.moveLeft = false; break;
        case 'KeyS': state.moveBackward = false; break;
        case 'KeyD': state.moveRight = false; break;
        case 'ShiftLeft': state.isSprinting = false; break;
    }
});

document.addEventListener('mousedown', (event) => {
    if (document.pointerLockElement !== document.body) {
        document.body.requestPointerLock();
        return; // Don't act on the click that locks the screen
    }

    if (event.button === 0 && !state.isAttacking && actions['attack']) {
        state.isAttacking = true;
        setTimeout(() => {
            if (state.isAttacking) {
                sfx.attack.currentTime = 0;
                sfx.attack.play().catch(() => {});
            }
        }, 400);
        fadeToAction('attack', 0.2);
        // Notify server of attack
        socket.emit('playerAttack');
        mixer.addEventListener('finished', restoreState);
    } else if (event.button === 2 && actions['block'] && !state.blockCooldown) {
        state.isBlocking = true;
        updateAnimationState();
    }
});

document.addEventListener('mouseup', (event) => {
    if (event.button === 2) {
        state.isBlocking = false;
        updateAnimationState();
    }
});

function restoreState(e) {
    if (e.action === actions['attack']) {
        state.isAttacking = false;
        mixer.removeEventListener('finished', restoreState);
        updateAnimationState();
    }
}

function updateAnimationState() {
    if (state.isAttacking) return;
    
    if (state.isJumping) {
        fadeToAction('jump', 0.2);
        return;
    }

    if (state.isBlocking) {
        fadeToAction('block', 0.2);
        return;
    }

    if (state.moveForward || state.moveBackward || state.moveLeft || state.moveRight) {
        if (state.isSprinting) {
            fadeToAction('run', 0.2);
        } else {
            fadeToAction('walk', 0.2);
        }
    } else {
        fadeToAction('idle', 0.2);
    }
}

function updateMovement(delta) {
    if (!mapLoaded || !model) return;

    const canMove = !state.isAttacking && !state.isBlocking;
    const currentSpeed = state.isSprinting ? speed * 2.5 : speed;

    let moveX = 0;
    let moveZ = 0;

    if (canMove) {
        const cameraDir = new THREE.Vector3();
        camera.getWorldDirection(cameraDir);
        cameraDir.y = 0; // Flatten to XZ plane
        cameraDir.normalize();

        const cameraRight = new THREE.Vector3();
        cameraRight.crossVectors(cameraDir, camera.up).normalize();

        const moveDir = new THREE.Vector3();

        if (state.moveForward) moveDir.add(cameraDir);
        if (state.moveBackward) moveDir.sub(cameraDir);
        if (state.moveLeft) moveDir.sub(cameraRight); // left is -right
        if (state.moveRight) moveDir.add(cameraRight);

        if (moveDir.lengthSq() > 0) {
            moveDir.normalize();
            
            const targetAngle = Math.atan2(moveDir.x, moveDir.z);
            let diff = targetAngle - model.rotation.y;
            // Shortest path to target angle
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            
            model.rotation.y += diff * 15 * delta;

            const stepDist = currentSpeed * delta;
            moveX = moveDir.x * stepDist;
            moveZ = moveDir.z * stepDist;
        }
    }

    // Horizontal Collision X & Z (Wall sliding)
    if (mapMeshes.length > 0 && (Math.abs(moveX) > 0.0001 || Math.abs(moveZ) > 0.0001)) {
        const radius = 0.5; // Collision radius around player
        
        // Shoot 3 rays per axis to give the ray 'thickness' and prevent clipping
        const offsetsX = [new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,0.4), new THREE.Vector3(0,0,-0.4)];
        const offsetsZ = [new THREE.Vector3(0,0,0), new THREE.Vector3(0.4,0,0), new THREE.Vector3(-0.4,0,0)];

        if (Math.abs(moveX) > 0.0001) {
            const dirX = new THREE.Vector3(Math.sign(moveX), 0, 0);
            let hit = false;
            for (let offset of offsetsX) {
                const origin = new THREE.Vector3(model.position.x, model.position.y + 0.6, model.position.z).add(offset);
                const rayX = new THREE.Raycaster(origin, dirX, 0, Math.abs(moveX) + radius);
                rayX.firstHitOnly = true;
                if (rayX.intersectObjects(mapMeshes, false).length > 0) hit = true;
            }
            if (hit) moveX = 0;
        }
        
        if (Math.abs(moveZ) > 0.0001) {
            const dirZ = new THREE.Vector3(0, 0, Math.sign(moveZ));
            let hit = false;
            for (let offset of offsetsZ) {
                const origin = new THREE.Vector3(model.position.x, model.position.y + 0.6, model.position.z).add(offset);
                const rayZ = new THREE.Raycaster(origin, dirZ, 0, Math.abs(moveZ) + radius);
                rayZ.firstHitOnly = true;
                if (rayZ.intersectObjects(mapMeshes, false).length > 0) hit = true;
            }
            if (hit) moveZ = 0;
        }
    }

    // Apply horizontal movement
    model.position.x += moveX;
    model.position.z += moveZ;

    const isWalking = state.isGrounded && !state.isJumping && (Math.abs(moveX) > 0.0001 || Math.abs(moveZ) > 0.0001);
    const newSurface = state.surface || 'stone';
    
    if (isWalking) {
        const activeSound = newSurface === 'grass' ? sfx.step_grass : sfx.step_stone;
        const inactiveSound = newSurface === 'grass' ? sfx.step_stone : sfx.step_grass;
        
        // Stop the inactive surface sound
        if (!inactiveSound.paused) {
            inactiveSound.pause();
            inactiveSound.currentTime = 0;
        }
        
        if (activeSound.paused) {
            activeSound.currentTime = 0;
            activeSound.play().catch(()=>{});
        }
        // Smoothly adjust playback rate instead of snapping, to avoid audio gap
        const targetRate = state.isSprinting ? 1.5 : 1.0;
        activeSound.playbackRate += (targetRate - activeSound.playbackRate) * 0.1;
    } else {
        if (!sfx.step_grass.paused) { sfx.step_grass.pause(); sfx.step_grass.currentTime = 0; }
        if (!sfx.step_stone.paused) { sfx.step_stone.pause(); sfx.step_stone.currentTime = 0; }
    }

    // Vertical Movement & Gravity
    if (state.isGrounded && !state.isJumping) {
        // Keep snapped to ground when walking down slopes
        velocity.y = -10.0;
    } else {
        velocity.y -= 30.0 * delta; // Gravity
    }
    
    model.position.y += velocity.y * delta;

    // Ground snap / Landing
    let hitGround = false;
    if (mapMeshes.length > 0 && velocity.y <= 0) {
        const fallDist = velocity.y * delta;
        const prevY = model.position.y - fallDist;
        
        // Shoot ray from previous frame's feet + 1.0 (to not miss ground passed during lag)
        const rayOrigin = new THREE.Vector3(model.position.x, prevY + 1.0, model.position.z);
        // Ray must reach from origin down to current position, plus a little extra
        const rayLength = Math.max(20, (prevY + 1.0) - model.position.y + 2.0);
        
        const raycaster = new THREE.Raycaster(rayOrigin, new THREE.Vector3(0, -1, 0), 0, rayLength);
        raycaster.firstHitOnly = true;
        
        const intersects = raycaster.intersectObjects(mapMeshes, false);
        if (intersects.length > 0) {
            const newY = intersects[0].point.y;
            const isWalkingDown = state.isGrounded && !state.isJumping; 
            
            // Allow snapping down if we are walking down a slope (up to 1.5 units)
            // Or if we are falling through the ground (ground is between prevY and currentY)
            if (newY <= prevY + 0.5) { // Ensure it's not a ceiling
                if ((isWalkingDown && newY >= model.position.y - 1.5) || newY >= model.position.y) {
                    model.position.y = newY;
                    velocity.y = 0;
                    hitGround = true;
                    
                    // Surface detection
                    let surface = 'stone';
                    const hitObj = intersects[0].object;
                    let hitMat = hitObj.material;
                    if (Array.isArray(hitMat)) {
                        const matIndex = intersects[0].face ? intersects[0].face.materialIndex : 0;
                        hitMat = hitMat[matIndex];
                    }
                    if (hitMat) {
                        const name = (hitMat.name || '').toLowerCase();
                        if (name.includes('grass') || name.includes('dirt') || name.includes('plant') || name.includes('weed') || name.includes('bush') || name.includes('path') || name.includes('terrain')) {
                            surface = 'grass';
                        }
                    }
                    state.surface = surface;
                    
                    if (!state.isGrounded) { // Just landed
                        const sound = surface === 'grass' ? sfx.land_grass : sfx.land_stone;
                        sound.currentTime = 0;
                        sound.play().catch(()=>{});
                    }
                    
                    if (state.isJumping) {
                        state.isJumping = false;
                    }
                }
            }
        }
    }
    state.isGrounded = hitGround;
    
    // Fall animation
    if (!state.isGrounded && velocity.y < -15.0 && !state.isJumping) {
        state.isJumping = true; // Use jump animation for falling
        updateAnimationState();
    }
    // Safety net: if fallen under the map, reset to ground at current X/Z
    if (model.position.y < -100) {
        const ray = new THREE.Raycaster(new THREE.Vector3(model.position.x, 1000, model.position.z), new THREE.Vector3(0, -1, 0));
        ray.firstHitOnly = true;
        const hits = ray.intersectObjects(mapMeshes, false);
        if (hits.length > 0) {
            model.position.y = hits[0].point.y + 1.0;
        } else {
            const spawn = getValidSpawn();
            spawn.y += 1.0;
            model.position.copy(spawn);
        }
        velocity.y = 0;
    }

    updateAnimationState();
}

function updateCamera() {
    if (!model) return;

    cameraTarget.copy(model.position);
    cameraTarget.y += 0.9;
    
    const camX = cameraTarget.x + cameraRadius * Math.sin(cameraYaw) * Math.cos(cameraPitch);
    const camY = cameraTarget.y + cameraRadius * Math.sin(cameraPitch);
    const camZ = cameraTarget.z + cameraRadius * Math.cos(cameraYaw) * Math.cos(cameraPitch);
    
    camera.position.set(camX, camY, camZ);
    camera.lookAt(cameraTarget);
}

window.addEventListener('resize', onWindowResize, false);

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    let delta = clock.getDelta();
    if (delta > 0.1) delta = 0.1; // Prevent physics explosion on lag spikes

    if (mixer) mixer.update(delta);

    updateMovement(delta);
    updateCamera();
    updateDayNight(delta);

    renderer.render(scene, camera);
}
// animate() is replaced by animateMP() below after socket setup ────────────────────────────────────────────────────────────
const SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : window.location.origin;  // same-origin in production

const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

let myId = null;
let myHp = 100;
const MAX_HP = 100;

// Remote player registry
const remotePlayers = {};
// { [id]: { model, mixer, actions, targetPos, targetRotY, currentAnim } }

// ── HUD helpers ────────────────────────────────────────────────────────────
const hpBar   = document.getElementById('hp-bar');
const hpLabel = document.getElementById('hp-label');
const deathScreen = document.getElementById('death-screen');
const playerCountEl = document.getElementById('player-count');

function setHp(hp) {
    myHp = Math.max(0, Math.min(MAX_HP, hp));
    const pct = (myHp / MAX_HP) * 100;
    hpBar.style.width = pct + '%';
    hpBar.style.background = myHp > 50
        ? `linear-gradient(90deg, #27ae60, #2ecc71)`
        : myHp > 25
            ? `linear-gradient(90deg, #f39c12, #e67e22)`
            : `linear-gradient(90deg, #c0392b, #e74c3c)`;
    hpLabel.textContent = `HP: ${myHp} / ${MAX_HP}`;
}

function updatePlayerCount(count) {
    const word = count === 1 ? 'игрок' : count < 5 ? 'игрока' : 'игроков';
    playerCountEl.textContent = `${count} ${word}`;
}

// ── Remote player: load & store ────────────────────────────────────────────
const remoteLoader = new FBXLoader();
remoteLoader.setPath('/assets/');

function spawnRemotePlayer(id, state) {
    if (remotePlayers[id]) return;

    remoteLoader.load('Paladin WProp J Nordstrom.fbx', (object) => {
        object.scale.setScalar(0.006);
        object.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });

        const rMixer = new THREE.AnimationMixer(object);
        const rActions = {};

        object.position.set(state.x || 0, state.y || 0, state.z || 0);
        scene.add(object);

        remotePlayers[id] = {
            model: object,
            mixer: rMixer,
            actions: rActions,
            targetPos: new THREE.Vector3(state.x || 0, state.y || 0, state.z || 0),
            targetRotY: state.rotY || 0,
            currentAnim: 'idle'
        };

        // Load a minimal set of animations for remote players
        function loadRA(file, name, cb) {
            remoteLoader.load(file, (anim) => {
                anim.animations[0].tracks = anim.animations[0].tracks.filter(t => !t.name.includes('.position'));
                const a = rMixer.clipAction(anim.animations[0]);
                if (name === 'attack' || name === 'jump') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
                rActions[name] = a;
                if (cb) cb();
            });
        }
        loadRA('sword and shield idle.fbx', 'idle', () => {
            loadRA('sword and shield walk.fbx', 'walk', () => {
                loadRA('sword and shield slash.fbx', 'attack', () => {
                    loadRA('sword and shield run.fbx', 'run', () => {
                        loadRA('sword and shield block idle.fbx', 'block', () => {
                            loadRA('sword and shield jump.fbx', 'jump', () => {
                                if (rActions['idle']) rActions['idle'].play();
                            });
                        });
                    });
                });
            });
        });
    });
}

function removeRemotePlayer(id) {
    const rp = remotePlayers[id];
    if (!rp) return;
    scene.remove(rp.model);
    delete remotePlayers[id];
}

function applyRemoteAnim(id, animName) {
    const rp = remotePlayers[id];
    if (!rp || rp.currentAnim === animName) return;
    const prev = rp.actions[rp.currentAnim];
    const next = rp.actions[animName];
    if (!next) return;
    if (prev && prev !== next) prev.fadeOut(0.2);
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
    rp.currentAnim = animName;
}

// ── Socket events ──────────────────────────────────────────────────────────
socket.on('init', ({ id, players, serverStartTime }) => {
    myId = id;
    if (serverStartTime) {
        serverTimeOffset = Date.now() - serverStartTime;
    }
    for (const [pid, pstate] of Object.entries(players)) {
        if (pid !== id) spawnRemotePlayer(pid, pstate);
    }
    updatePlayerCount(Object.keys(players).length);
});

socket.on('playerJoined', ({ id, state }) => {
    spawnRemotePlayer(id, state);
});

socket.on('playerMoved', ({ id, state }) => {
    const rp = remotePlayers[id];
    if (!rp) return;
    rp.targetPos.set(state.x, state.y, state.z);
    rp.targetRotY = state.rotY;
    applyRemoteAnim(id, state.anim || 'idle');
});

socket.on('playerAttacked', ({ id }) => {
    const rp = remotePlayers[id];
    if (!rp) return;
    applyRemoteAnim(id, 'attack');
    
    // Play sound from remote player
    const sound = sfx.attack.cloneNode();
    sound.volume = 0.3;
    sound.play().catch(() => {});

    // Auto-restore after attack anim
    setTimeout(() => applyRemoteAnim(id, 'idle'), 1200);
});

socket.on('playerLeft', ({ id }) => {
    removeRemotePlayer(id);
});

socket.on('playerCount', (count) => {
    updatePlayerCount(count);
});

socket.on('youWereHit', ({ hp }) => {
    setHp(hp);
    // Flash red
    document.body.style.background = 'rgba(255,0,0,0.3)';
    setTimeout(() => document.body.style.background = '', 200);
});

socket.on('youDied', () => {
    deathScreen.style.display = 'block';
    setHp(0);
});

socket.on('shieldBroken', () => {
    if (state.isBlocking) {
        state.isBlocking = false;
        state.blockCooldown = true;
        updateAnimationState();
        
        // Block sound
        const sound = sfx.land_stone.cloneNode();
        sound.volume = 0.5;
        sound.play().catch(() => {});

        setTimeout(() => {
            state.blockCooldown = false;
        }, 2000);
    }
});

socket.on('attackBlocked', ({ targetId }) => {
    // Play sound when hitting someone else's shield
    const sound = sfx.land_stone.cloneNode();
    sound.volume = 0.5;
    sound.play().catch(() => {});
});

socket.on('respawn', ({ hp }) => {
    setHp(hp);
    deathScreen.style.display = 'none';
    if (model && mapMeshes.length > 0) {
        const spawn = getValidSpawn();
        model.position.copy(spawn);
        velocity.y = 0;
    }
});

// ── Network send loop (20Hz) ───────────────────────────────────────────────
let lastNetSend = 0;
function sendNetworkUpdate() {
    const now = performance.now();
    if (now - lastNetSend < 50) return; // 20Hz
    lastNetSend = now;
    if (!model) return;

    let animName = 'idle';
    if (state.isAttacking) animName = 'attack';
    else if (state.isBlocking) animName = 'block';
    else if (state.isJumping) animName = 'jump';
    else if (state.moveForward || state.moveBackward || state.moveLeft || state.moveRight) {
        animName = state.isSprinting ? 'run' : 'walk';
    }

    socket.emit('playerUpdate', {
        x: model.position.x,
        y: model.position.y,
        z: model.position.z,
        rotY: model.rotation.y,
        anim: animName
    });
}

// Patch animate() to also interpolate remote players and send updates
const _origAnimate = animate;
function animateMP() {
    requestAnimationFrame(animateMP);

    let delta = clock.getDelta();
    if (delta > 0.1) delta = 0.1;

    if (mixer) mixer.update(delta);

    updateMovement(delta);
    updateCamera();
    updateDayNight(delta);
    sendNetworkUpdate();

    // Interpolate remote players
    for (const rp of Object.values(remotePlayers)) {
        rp.model.position.lerp(rp.targetPos, 0.2);
        // Smooth rotation
        let dr = rp.targetRotY - rp.model.rotation.y;
        while (dr > Math.PI) dr -= Math.PI * 2;
        while (dr < -Math.PI) dr += Math.PI * 2;
        rp.model.rotation.y += dr * 0.2;
        rp.mixer.update(delta);
    }

    renderer.render(scene, camera);
}

// Replace the original rAF loop with the MP one
animateMP();

// Background Music
const bgMusic = new Audio('/03 River of Life.mp3');
bgMusic.loop = true;
bgMusic.volume = 0.1; // Not very loud

// Force restart if loop fails
bgMusic.addEventListener('ended', () => {
    bgMusic.currentTime = 0;
    bgMusic.play().catch(() => {});
});

// Sound Effects
const sfx = {
    step_stone: new Audio('/Хотьба по камню.mp3'),
    step_grass: new Audio('/Хотьба по траве.mp3'),
    land_stone: new Audio('/Падение на камень.mp3'),
    land_grass: new Audio('/Падение на траву.mp3'),
    attack: new Audio('/Взмах мечом.mp3')
};
sfx.step_stone.loop = true;
sfx.step_grass.loop = true;
Object.values(sfx).forEach(a => a.volume = 0.5);
let lastStepTime = 0;

// Play on click
let hasInteracted = false;
document.addEventListener('click', () => {
    hasInteracted = true;
    if (bgMusic.paused) {
        bgMusic.play().catch(e => console.log('Music play blocked:', e));
    }
});

// Pause when switching tabs
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        bgMusic.pause();
    } else if (hasInteracted) {
        bgMusic.play().catch(e => console.log('Music play blocked:', e));
    }
});
