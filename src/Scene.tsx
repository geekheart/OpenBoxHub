import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ModelData, PartData, Params } from './types'

export type ViewMode = 'assembly' | 'open' | 'exploded'
export type CameraView = { name: 'iso' | 'top' | 'front'; tick: number }
export const INNER_COLORS = ['#d4dcca', '#d5c2aa', '#aebfc4', '#c5bbcf', '#d8c8a0', '#b4c8b4', '#c7b5aa', '#b3c8d1']
type Props = {
  model: ModelData | null; params: Params; mode: ViewMode; explosion: number
  visible: { outer: boolean; inner: boolean; lid: boolean }; transparent: boolean
  selected: string | null; onSelect: (id: string | null) => void
  cameraView: CameraView; autoRotate: boolean; onError: (message: string) => void
}
type RenderPart = { data: PartData; mesh: THREE.Mesh; line: THREE.LineSegments; target: THREE.Vector3 }

export default function Scene(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const live = useRef(props)
  live.current = props
  const runtime = useRef<{ scene: THREE.Scene; renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; controls: OrbitControls; parts: RenderPart[]; grid: THREE.GridHelper; plane: THREE.Mesh; fit: (view: string) => void } | null>(null)

  useEffect(() => {
    const container = host.current!
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) }
    catch { live.current.onError('浏览器无法启用 3D 加速，请在支持 WebGL 的浏览器中打开。'); return }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0xf0f1ed, 1)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.22
    renderer.domElement.setAttribute('aria-label', '收纳盒三维预览，拖动旋转，滚轮缩放')
    container.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 8000)
    camera.up.set(0, 0, 1)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    controls.minDistance = 35
    controls.maxDistance = 2200
    controls.autoRotateSpeed = 0.6
    controls.maxPolarAngle = Math.PI
    const ambient = new THREE.HemisphereLight(0xffffff, 0x788479, 2.5)
    ambient.position.set(0, 0, 300)
    scene.add(ambient)
    const key = new THREE.DirectionalLight(0xfffcf3, 3.4)
    key.position.set(-180, -170, 400)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -420; key.shadow.camera.right = 420
    key.shadow.camera.top = 420; key.shadow.camera.bottom = -420
    key.shadow.camera.near = 1; key.shadow.camera.far = 1400
    key.shadow.bias = -0.0002
    key.shadow.normalBias = 0.06
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xf0f7ff, 1.1)
    fill.position.set(200, 140, 160); scene.add(fill)
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.ShadowMaterial({ opacity: 0.12 }))
    plane.position.z = -0.5; plane.receiveShadow = true; scene.add(plane)
    const grid = new THREE.GridHelper(1200, 120, 0xc7cec4, 0xdce1d8)
    grid.rotation.x = Math.PI / 2; grid.position.z = -0.6
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material]
    gridMaterials.forEach(m => { m.transparent = true; m.opacity = 0.4 })
    scene.add(grid)
    function fit(view: string) {
      const p = live.current.params
      const span = Math.max(p.width, p.depth, p.height * 1.7, ...(live.current.model?.parts.map(part => Math.max(...part.bounds)) ?? []))
      const aspectCorrection = Math.max(1, 1 / camera.aspect)
      const scale = span * aspectCorrection
      controls.maxDistance = Math.max(2200, scale * 7)
      camera.far = Math.max(8000, scale * 15)
      camera.updateProjectionMatrix()
      const center = new THREE.Vector3(0, p.depth * 0.05, p.height * 0.8)
      controls.target.copy(center)
      if (view === 'top') camera.position.set(0, -0.01, center.z + scale * 2.8)
      else if (view === 'front') camera.position.set(0, -scale * 3, p.height * 0.65)
      else camera.position.set(scale * 1.45, -scale * 1.82, scale * 1.66)
      camera.lookAt(center); controls.update()
    }
    runtime.current = { scene, renderer, camera, controls, parts: [], grid, plane, fit }
    const resize = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); fit(live.current.cameraView.name)
    })
    resize.observe(container)
    camera.aspect = container.clientWidth / Math.max(container.clientHeight, 1)
    camera.updateProjectionMatrix(); fit('iso')
    const down = new THREE.Vector2()
    const raycaster = new THREE.Raycaster()
    const pointerDown = (e: PointerEvent) => down.set(e.clientX, e.clientY)
    const pointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 5) return
      const rect = renderer.domElement.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera)
      const hits = raycaster.intersectObjects(runtime.current!.parts.filter(p => p.mesh.visible).map(p => p.mesh))
      live.current.onSelect(hits.length ? String(hits[0].object.userData.partId) : null)
    }
    renderer.domElement.addEventListener('pointerdown', pointerDown)
    renderer.domElement.addEventListener('pointerup', pointerUp)
    const noContext = (e: Event) => e.preventDefault()
    renderer.domElement.addEventListener('contextmenu', noContext)
    let frame = 0, prior = performance.now()
    const animate = (now: number) => {
      const dt = Math.min((now - prior) / 1000, 0.05); prior = now
      const rt = runtime.current
      if (!rt) return
      const { mode, explosion, visible, params, selected, transparent, autoRotate } = live.current
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      for (const part of rt.parts) {
        const { data, mesh, line, target } = part
        target.fromArray(data.assemblyPosition)
        if (mode === 'open' && data.kind === 'lid') {
          target.y += params.depth * 0.68; target.z += Math.max(28, params.height * 0.85)
        }
        if (mode === 'exploded') {
          const a = explosion / 100
          if (data.kind === 'inner') {
            target.x *= 1 + a * 0.75; target.y *= 1 + a * 0.75
            target.z += (params.height * 1.15 + 18) * a
          }
          if (data.kind === 'lid') target.z += (params.height * 2.25 + 45) * a
        }
        mesh.position.lerp(target, reduceMotion ? 1 : 1 - Math.exp(-dt * 10))
        line.position.copy(mesh.position)
        mesh.visible = visible[data.kind]; line.visible = mesh.visible
        const mat = mesh.material as THREE.MeshStandardMaterial
        const faded = transparent && data.kind === 'outer'
        mat.transparent = faded; mat.opacity = faded ? 0.24 : 1; mat.depthWrite = !faded
        mat.emissive.set(selected === data.id ? 0x6b7f35 : 0x000000)
        mat.emissiveIntensity = selected === data.id ? 0.16 : 0
        ;(line.material as THREE.LineBasicMaterial).opacity = selected === data.id ? 0.7 : faded ? 0.25 : 0.13
      }
      controls.autoRotate = autoRotate && !reduceMotion
      controls.update(); renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', pointerDown)
      renderer.domElement.removeEventListener('pointerup', pointerUp)
      renderer.domElement.removeEventListener('contextmenu', noContext)
      scene.traverse(obj => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose()
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          mats.forEach(m => m.dispose())
        }
      })
      renderer.dispose(); renderer.domElement.remove(); runtime.current = null
    }
  }, [])

  useEffect(() => {
    const rt = runtime.current
    if (!rt || !props.model) return
    for (const part of rt.parts) {
      rt.scene.remove(part.mesh, part.line)
      part.mesh.geometry.dispose(); (part.mesh.material as THREE.Material).dispose()
      part.line.geometry.dispose(); (part.line.material as THREE.Material).dispose()
    }
    let innerIndex = 0
    rt.parts = props.model.parts.map(data => {
      const indexed = new THREE.BufferGeometry()
      indexed.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
      indexed.setIndex(new THREE.BufferAttribute(data.indices, 1))
      const geometry = indexed.toNonIndexed(); geometry.computeVertexNormals()
      const color = data.kind === 'outer' ? '#708671' : data.kind === 'lid' ? '#81947a' : INNER_COLORS[innerIndex++ % INNER_COLORS.length]
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.69, metalness: 0, side: THREE.FrontSide }))
      mesh.castShadow = true; mesh.receiveShadow = true
      mesh.position.fromArray(data.assemblyPosition)
      if (data.assemblyRotation) mesh.rotation.fromArray([...data.assemblyRotation, 'XYZ'])
      mesh.userData.partId = data.id
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(indexed, 32), new THREE.LineBasicMaterial({ color: '#324a39', transparent: true, opacity: 0.13 }))
      line.position.copy(mesh.position); line.rotation.copy(mesh.rotation)
      indexed.dispose(); rt.scene.add(mesh, line)
      return { data, mesh, line, target: mesh.position.clone() }
    })
  }, [props.model])

  useEffect(() => { runtime.current?.fit(props.cameraView.name) }, [props.cameraView])
  return <div className="three-scene" ref={host} />
}
