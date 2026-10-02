/**
 * Automated spike bench.
 *
 * Every spike that can be answered without a human runs itself on load and
 * posts its findings back to the main process. S0 is the exception and says so:
 * it measures whether pointer events keep arriving after the cursor leaves the
 * window, which requires a real hand on a real mouse, so it arms itself and
 * waits for a drag that only a person can perform.
 *
 * Running the measurable ones automatically matters because it turns "the next
 * developer must sit down and click nine buttons" into "run one command and read
 * the verdicts" — and it means the results can be re-checked after any change.
 *
 * Findings are returned as a single serialisable object so the runner can write
 * them to `spikes/report.json` without any opinion about their shape.
 */
;(function () {
  'use strict'

  /** Collected findings, keyed by spike id. */
  const results = {}

  /**
   * Record a finding and mirror it to the console.
   * @param {string} id - the spike identifier.
   * @param {unknown} payload - the finding.
   */
  function record(id, payload) {
    results[id] = payload
    console.log(`[spike] ${id} ${JSON.stringify(payload)}`)
  }

  /** A verdict string that reads the same in the terminal and the report. */
  function verdict(passed, total) {
    if (passed === total) return 'pass'
    if (passed === 0) return 'fail'
    return 'partial'
  }

  /* ------------------------------------------------------------- S2 ------ */
  /**
   * Does `moveBefore` preserve runtime state that a detach-and-reattach loses?
   *
   * This is the question that decides whether Tier 0 can be the default
   * extraction path. It builds a subtree holding the four kinds of state most
   * likely to be lost — focus, a text selection, an in-flight CSS transition and
   * a loaded iframe — moves it, and compares before against after.
   */
  function spikeMoveBefore() {
    const host = document.createElement('div')
    host.id = 's2-host'
    host.innerHTML = `
      <div id="s2-card" style="padding:8px">
        <input id="s2-input" value="typed by the user">
        <div id="s2-anim" style="width:40px;height:10px;background:#3b82f6;transition:width 8s linear"></div>
        <iframe id="s2-frame" srcdoc="<p id='inner'>frame content</p>" style="width:160px;height:40px"></iframe>
      </div>
    `
    document.body.appendChild(host)

    const card = host.querySelector('#s2-card')
    const input = host.querySelector('#s2-input')
    const anim = host.querySelector('#s2-anim')
    const frame = host.querySelector('#s2-frame')

    return new Promise((resolve) => {
      // Give the iframe a loaded document and start the transition, so there is
      // real state to preserve rather than an empty shell.
      frame.addEventListener('load', () => {
        input.focus()
        input.setSelectionRange(2, 5)
        anim.style.width = '300px'

        // Two frames: one for the transition to start, one for it to have
        // advanced, so a preserved animation is measurably further along.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const before = snapshot()
          const destination = document.createElement('div')
          destination.id = 's2-destination'
          document.body.appendChild(destination)

          let method = 'moveBefore'
          try {
            destination.moveBefore(card, null)
          } catch (error) {
            method = `moveBefore-threw:${String(error)}`
            destination.appendChild(card)
          }

          requestAnimationFrame(() => {
            const after = snapshot()
            const checks = {
              focusPreserved: before.activeId === after.activeId && after.activeId === 's2-input',
              selectionPreserved: before.selectionStart === after.selectionStart
                && before.selectionEnd === after.selectionEnd,
              animationNotReset: after.animWidth >= before.animWidth,
              iframeNotReloaded: before.frameContent === after.frameContent
                && after.frameContent === 'frame content',
            }
            const passed = Object.values(checks).filter(Boolean).length
            resolve({
              verdict: verdict(passed, 4),
              method,
              preserved: `${passed}/4`,
              checks,
              before,
              after,
            })
          })
        }))
      }, { once: true })

      /** Capture the state under test. */
      function snapshot() {
        const active = document.activeElement
        return {
          activeId: active === null ? null : active.id,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
          animWidth: Math.round(anim.getBoundingClientRect().width),
          // Reading through `contentDocument` only works for a same-origin
          // frame, which is exactly the case a reload would clear.
          frameContent: (() => {
            try {
              return frame.contentDocument?.body?.textContent?.trim() ?? null
            } catch {
              return null
            }
          })(),
        }
      }
    })
  }

  /* ------------------------------------------------------------- S3 ------ */
  /**
   * Does the stand-in hold when the parent is manipulated while the element is
   * away?
   *
   * Without it, `parent.removeChild(movedNode)` throws `NotFoundError` and takes
   * down the surrounding subtree. This exercises each of the four intercepted
   * methods and then confirms the guard is fully released afterwards.
   */
  function spikeStandIn() {
    const hostDocument = document
    const host = hostDocument.createElement('div')
    host.id = 's3-host'
    host.innerHTML = `
      <ul id="s3-parent">
        <li id="s3-row-0">row 0</li>
        <li id="s3-row-1">row 1</li>
        <li id="s3-row-2">row 2</li>
      </ul>
    `
    hostDocument.body.appendChild(host)

    const parent = host.querySelector('#s3-parent')
    const target = host.querySelector('#s3-row-1')

    // Reproduce the two behaviours under test directly, so the spike does not
    // depend on the build having run. The logic mirrors `stand-in.ts`; if that
    // file changes, this must change with it, which is why the assertions below
    // name the operations rather than the implementation.
    const placeholder = hostDocument.createElement('dsh-float-anchor')
    placeholder.style.display = 'none'
    parent.replaceChild(placeholder, target)

    const methods = ['removeChild', 'insertBefore', 'appendChild', 'replaceChild']
    const originals = {}
    for (const name of methods) {
      const inherited = parent[name].bind(parent)
      originals[name] = inherited
      parent[name] = function (...args) {
        const rewritten = args.map((value, index) =>
          index < 2 && value === target ? placeholder : value)
        return inherited(...rewritten)
      }
    }

    const checks = {}
    const errors = []

    /** Run one operation, recording whether it threw. */
    function attempt(label, run) {
      try {
        run()
        checks[label] = 'ok'
      } catch (error) {
        checks[label] = `threw: ${String(error)}`
        errors.push(label)
      }
    }

    attempt('removeChild(target)', () => parent.removeChild(target))
    attempt('appendChild(target)', () => parent.appendChild(target))
    attempt('removeChild(placeholder)', () => parent.removeChild(placeholder))
    attempt('insertBefore(target, first)', () => parent.insertBefore(target, parent.firstChild))
    attempt('replaceChild(placeholder, target)', () => parent.replaceChild(placeholder, target))

    // Release the guard the way the real restore function does, then verify the
    // operations behave natively again.
    let restoreError = null
    try {
      for (const name of methods) delete parent[name]
      if (placeholder.parentNode === parent) parent.replaceChild(target, placeholder)
    } catch (error) {
      restoreError = String(error)
    }
    attempt('post-restore removeChild', () => {
      if (target.parentNode === parent) parent.removeChild(target)
    })
    attempt('post-restore appendChild', () => parent.appendChild(target))

    const passed = Object.values(checks).filter((value) => value === 'ok').length
    const total = Object.keys(checks).length
    return {
      verdict: verdict(passed, total),
      operationsClean: `${passed}/${total}`,
      checks,
      errors,
      restoreError,
      // The specific failure mode this guards against, stated once.
      consequenceIfBroken: 'parent.removeChild(movedNode) throws NotFoundError and the host subtree unmounts',
    }
  }

  /* ------------------------------------------------------------- S4 ------ */
  /**
   * Which CSS mechanisms does a `display: contents` shell chain reproduce?
   *
   * The skeleton approach rests on one claim: selectors match the DOM tree, not
   * the box tree, so shells that generate no box still satisfy child, sibling,
   * `:nth-child` and `:has()` rules. Each probe tests one of those relationships
   * by comparing the real tree against a shell-rebuilt equivalent.
   *
   * Two things this has to get right, because the first version got both wrong
   * and reported a false failure:
   *
   * 1. **The shell must be inside a container the probe selectors reach.** An
   *    earlier version nested it under a different id, so `#host > .a > .b`
   *    could never match no matter how correct the skeleton was.
   * 2. **Styles must be applied before measuring.** A style element inserted in
   *    the same task as the markup is not guaranteed to have been applied by the
   *    time `getComputedStyle` runs, which yields empty strings that look like a
   *    cascade failure. The probe forces a reflow first.
   */
  async function spikeSkeleton() {
    const style = document.createElement('style')
    // Rules are anchored on a `.s4-root` ancestor, so the identical selector can
    // be evaluated against the real tree and against the rebuilt one. That is
    // what makes the comparison meaningful: the question is never "did my
    // literal rule fire" but "does the shell reproduce what the real tree
    // produces".
    style.textContent = `
      .s4-root > .s4-a > .s4-b { color: rgb(178, 42, 36); }
      .s4-root .s4-b { border-top-width: 2px; border-top-style: solid; }
      .s4-root .s4-list > .s4-item:nth-child(2) { font-weight: 700; }
      .s4-root .s4-a + .s4-a2 > .s4-b { letter-spacing: 3px; }
      .s4-root .s4-a:has(.s4-b) { padding-top: 9px; }
    `
    document.head.appendChild(style)

    /** Build one tree: real ancestors, or shells holding a copy. */
    function build(mode) {
      const root = document.createElement('div')
      root.className = 's4-root'
      root.id = `s4-${mode}`

      // In skeleton mode every ancestor becomes a `display: contents` shell that
      // copies the real element's classes — which is precisely what
      // `buildSkeleton` does. Building the shell any other way would test a
      // structure the implementation never produces.
      const shellify = (element) => {
        if (mode !== 'skeleton') return element
        element.setAttribute('data-dsh-float-shell', 'contents')
        element.style.display = 'contents'
        return element
      }

      shellify(root)

      const a = shellify(document.createElement('div'))
      a.className = 's4-a'
      const b = document.createElement('div')
      b.className = 's4-b'
      b.textContent = 'target'
      a.appendChild(b)

      const a2 = shellify(document.createElement('div'))
      a2.className = 's4-a2'
      const b2 = document.createElement('div')
      b2.className = 's4-b'
      a2.appendChild(b2)

      const list = shellify(document.createElement('ul'))
      list.className = 's4-list'
      const item1 = document.createElement('li')
      item1.className = 's4-item'
      const item2 = document.createElement('li')
      item2.className = 's4-item'
      list.append(item1, item2)

      root.append(a, a2, list)
      return { root, a, b, item2, a2, list }
    }

    const real = build('real')
    const shell = build('skeleton')
    const host = document.getElementById('s4-mount')
    host.append(real.root, shell.root)

    // Force a synchronous style recalculation before any measurement.
    //
    // Inserting a stylesheet and reading `getComputedStyle` in the same task is
    // not reliable: the reads can reflect the pre-stylesheet cascade and come
    // back empty, which looks exactly like a failed rule. Reading a layout
    // property forces the recalc, and awaiting a frame lets the engine settle.
    void host.offsetHeight
    void document.body.offsetHeight
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const probes = [
      { id: 'childSelector', select: '.s4-root > .s4-a > .s4-b', property: 'color', expect: 'rgb(178, 42, 36)' },
      { id: 'descendantSelector', select: '.s4-root .s4-b', property: 'borderTopWidth', expect: '2px' },
      { id: 'nthChild', select: '.s4-root .s4-list > .s4-item:nth-child(2)', property: 'fontWeight', expect: '700' },
      { id: 'siblingSelector', select: '.s4-root .s4-a + .s4-a2 > .s4-b', property: 'letterSpacing', expect: '3px' },
      { id: 'hasSelector', select: '.s4-root .s4-a:has(.s4-b)', property: 'paddingTop', expect: '9px' },
    ]

    /**
     * Read a computed property, accepting either naming convention.
     *
     * `getComputedStyle().getPropertyValue()` only accepts kebab-case names, so
     * passing `borderTopWidth` returns an empty string — which is
     * indistinguishable from "the rule never applied". That mistake made four of
     * these probes look like skeleton failures when the real tree did not match
     * them either. Converting here removes the trap.
     */
    const readProperty = (element, property) => {
      const name = property.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)
      return getComputedStyle(element).getPropertyValue(name).trim()
    }

    const results = {}
    for (const probe of probes) {
      // Each probe is isolated: one selector that the platform refuses must not
      // hide the verdict for the others.
      try {
        // Ask the platform where the selector lands in each tree, so a probe that
        // never applied explains itself instead of reporting an empty string that
        // looks like a cascade failure.
        const realTarget = real.root.parentElement?.querySelector(probe.select) ?? null
        const shellTarget = shell.root.parentElement?.querySelector(probe.select) ?? null

        const fallbackReal = probe.id === 'nthChild' ? real.item2 : real.b
        const fallbackShell = probe.id === 'nthChild' ? shell.item2 : shell.b
        const realValue = readProperty(realTarget ?? fallbackReal, probe.property)
        const shellValue = readProperty(shellTarget ?? fallbackShell, probe.property)

        // The meaningful comparison: did the shell reproduce the real tree's
        // result? Comparing against the literal instead would count a rule that
        // matched neither tree as a failure of the skeleton, which it is not.
        const ruleTookEffect = realValue === probe.expect
        results[probe.id] = {
          select: probe.select,
          expected: probe.expect,
          realValue,
          shellValue,
          matchedInRealTree: realTarget !== null,
          matchedInShellTree: shellTarget !== null,
          ruleTookEffect,
          reproduced: ruleTookEffect && shellValue === realValue,
        }
      } catch (error) {
        results[probe.id] = { select: probe.select, errored: String(error) }
      }
    }

    const evaluable = Object.values(results).filter((row) => row.ruleTookEffect).length
    const reproduced = Object.values(results).filter((row) => row.reproduced).length

    // The known gap from the plan: an element that generates no layout box
    // cannot serve as a query container.
    //
    // Measuring the *computed* `container-type` does not settle this. Chromium
    // keeps the declared value in the computed style even on a
    // `display: contents` element, while never establishing a query container —
    // so the property reads as present and the behaviour is absent. The test
    // therefore has to be behavioural: does a `@container` rule inside the shell
    // actually match?
    const containerStyle = document.createElement('style')
    containerStyle.textContent = `
      .s4-cq-probe { container-type: inline-size; }
      @container (min-width: 1px) {
        .s4-cq-target { color: rgb(9, 8, 7); }
      }
    `
    document.head.appendChild(containerStyle)

    const buildContainerCase = (display) => {
      const outer = document.createElement('div')
      outer.className = 's4-cq-probe'
      outer.style.display = display
      outer.style.width = '400px'
      if (display === 'contents') outer.setAttribute('data-dsh-float-shell', 'contents')
      const inner = document.createElement('div')
      inner.className = 's4-cq-target'
      outer.appendChild(inner)
      host.appendChild(outer)
      return { outer, inner }
    }

    const realCase = buildContainerCase('block')
    const shellCase = buildContainerCase('contents')
    void host.offsetHeight
    await new Promise((resolve) => requestAnimationFrame(resolve))

    const realQueryMatched = readProperty(realCase.inner, 'color') === 'rgb(9, 8, 7)'
    const shellQueryMatched = readProperty(shellCase.inner, 'color') === 'rgb(9, 8, 7)'

    return {
      verdict: evaluable === 0 ? 'inconclusive' : verdict(reproduced, evaluable),
      reproduced: `${reproduced}/${probes.length}`,
      probesEvaluable: `${evaluable}/${probes.length}`,
      results,
      containerProbe: {
        realContainerType: getComputedStyle(realCase.outer).containerType,
        shellContainerType: getComputedStyle(shellCase.outer).containerType,
        realDisplay: getComputedStyle(realCase.outer).display,
        shellDisplay: getComputedStyle(shellCase.outer).display,
        // Behavioural, not declarative: only this distinguishes "the property is
        // reported" from "queries actually resolve against it".
        realQueryMatched,
        shellQueryMatched,
        gapConfirmed: realQueryMatched && !shellQueryMatched,
        note: 'the computed value survives on a contents element, but queries do not resolve against it',
        repair: 'give that ancestor a real box and pin it to the original measured size',
      },
    }
  }

  /* ---------------------------------------------------------- S6 / S7 ---- */
  /**
   * Where the shadow boundary stops a skeleton, and whether scoped-style
   * attributes travel on a rebuilt shell.
   *
   * S6 is expected to show a hard limit rather than a bug, so its verdict is
   * about confirming the limit rather than passing a test.
   *
   * S7's first version reported a false failure by inserting the stylesheet and
   * measuring in the same task. It now asserts against a control element and
   * forces a reflow first, so a real "attribute is required" result is
   * distinguishable from "the rule never applied".
   */
  async function spikeBoundaries() {
    // S6: a shell lives in the light DOM, so content inside a shadow root is
    // unreachable from it. That is a property of the platform.
    const host = document.createElement('div')
    host.id = 's67-host'
    host.innerHTML = '<article class="s67-outer"><div id="s67-mount"></div></article>'
    document.body.appendChild(host)

    const mount = host.querySelector('#s67-mount')
    const shadow = mount.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<div class="s67-real">shadow content</div>'

    const shadowChild = shadow.querySelector('.s67-real')
    const s6 = {
      verdict: 'informational',
      realIsInShadow: shadowChild !== null && shadowChild.getRootNode() instanceof ShadowRoot,
      reachableFromLightDom: host.querySelector('.s67-real') !== null,
      boundaryBlocksSkeleton: host.querySelector('.s67-real') === null,
      downgradeTo: 'Tier 1 semantic rebuild, or Tier 3 bitmap',
    }

    // S7: a scoped rule binds its selector to an attribute on the element, so
    // the attribute must be copied for the rule to keep matching. Three
    // elements make the result unambiguous: one with the attribute, one
    // without, and one control that must match either way.
    const probe = document.createElement('div')
    probe.innerHTML = `
      <div id="s7-with" class="s67-scoped" data-v-abc123><span class="s67-child">with</span></div>
      <div id="s7-without" class="s67-scoped"><span class="s67-child">without</span></div>
      <div id="s7-control"><span class="s67-child">control</span></div>
    `
    document.body.appendChild(probe)

    const style = document.createElement('style')
    style.textContent = `
      .s67-scoped[data-v-abc123] > .s67-child { color: rgb(1, 2, 3); }
      #s7-control > .s67-child { color: rgb(4, 5, 6); }
    `
    document.head.appendChild(style)

    void probe.offsetHeight
    await new Promise((resolve) => requestAnimationFrame(resolve))

    const colourOf = (id) => {
      const element = probe.querySelector(`#${id} > .s67-child`)
      return element === null ? '' : getComputedStyle(element).color
    }

    const withAttribute = colourOf('s7-with')
    const withoutAttribute = colourOf('s7-without')
    const control = colourOf('s7-control')

    const s7 = {
      // The control proves the stylesheet and the measurement both work, which
      // is what makes the other two readings trustworthy.
      controlMatched: control === 'rgb(4, 5, 6)',
      scopedRuleNeedsAttribute: withAttribute === 'rgb(1, 2, 3)',
      ruleDoesNotMatchWithout: withoutAttribute !== 'rgb(1, 2, 3)',
      conclusion: 'copy class and data-* onto shells; a scoped rule stops matching without its attribute',
    }
    s7.verdict = s7.controlMatched && s7.scopedRuleNeedsAttribute && s7.ruleDoesNotMatchWithout
      ? 'confirmed' : 'inconclusive'

    return { S6_shadowBoundary: s6, S7_scopedAttributes: s7 }
  }

  /* --------------------------------------------------------------- S0 ---- */
  /**
   * Arm the out-of-window pointer capture.
   *
   * Nothing here can be automated: the question is what the engine reports once
   * the cursor leaves the window, and only a real drag can produce that. The
   * panel arms itself and explains what to do.
   */
  function armPointerTravelProbe() {
    const samples = []
    let capturing = false

    const state = document.getElementById('s0-state')
    const output = document.getElementById('s0-out')

    window.addEventListener('pointermove', (event) => {
      if (!capturing) return
      samples.push({
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY),
        screenX: Math.round(event.screenX),
        screenY: Math.round(event.screenY),
        // Negative or beyond the viewport means the engine kept reporting after
        // the cursor left, which is what makes exact window placement possible.
        outside: event.clientX < 0 || event.clientY < 0
          || event.clientX > window.innerWidth || event.clientY > window.innerHeight,
      })
      if (state !== null) state.textContent = `capturing · ${samples.length} samples`
      if (output !== null) output.textContent = JSON.stringify(samples.slice(-5), null, 1)
    }, true)

    window.addEventListener('pointerup', () => {
      if (!capturing) return
      capturing = false
      const outside = samples.filter((sample) => sample.outside)
      const lastInside = [...samples].reverse().find((sample) => !sample.outside) ?? null
      const finding = {
        verdict: outside.length > 0 ? 'pass' : 'fail',
        totalSamples: samples.length,
        outsideSamples: outside.length,
        lastInside,
        firstOutside: outside[0] ?? null,
        exactPlacementViable: outside.length > 0,
        fallback: outside.length > 0
          ? 'none needed: release coordinates are usable for exact window placement'
          : 'arm an edge band and compute placement from the last inside coordinate',
      }
      record('S0_pointerPastEdge', finding)
      if (state !== null) state.textContent = `done · ${outside.length} of ${samples.length} samples outside`
      if (output !== null) output.textContent = JSON.stringify(finding, null, 1)
    }, true)

    const start = document.getElementById('s0-start')
    if (start !== null) {
      start.addEventListener('click', () => {
        samples.length = 0
        capturing = true
        if (state !== null) state.textContent = 'capturing · drag the cursor out of the window now'
        if (output !== null) output.textContent = 'Move the cursor outside the window, then release.'
      })
    }
  }

  /* ------------------------------------------------------------ driver --- */

  const setState = (id, text) => {
    const node = document.getElementById(id)
    if (node !== null) node.textContent = text
  }
  const setOutput = (id, value) => {
    const node = document.getElementById(id)
    if (node !== null) node.textContent = JSON.stringify(value, null, 1)
  }

  /** Run every automatable spike, then publish the results. */
  async function runAll() {
    const auto = []

    auto.push((async () => {
      setState('s2-state', 'running…')
      const finding = await spikeMoveBefore()
      record('S2_moveBeforeState', finding)
      setState('s2-state', `${finding.verdict} · ${finding.preserved} preserved`)
      setOutput('s2-out', finding)
    })())

    auto.push((async () => {
      setState('s3-state', 'running…')
      const finding = spikeStandIn()
      record('S3_standInUnderChurn', finding)
      setState('s3-state', `${finding.verdict} · ${finding.operationsClean} operations clean`)
      setOutput('s3-out', finding)
    })())

    auto.push((async () => {
      setState('s4-state', 'running…')
      try {
        const finding = await spikeSkeleton()
        record('S4_skeletonSelectors', finding)
        setState('s4-state', `${finding.verdict} · ${finding.reproduced} reproduced (${finding.probesEvaluable} rules applied)`)
        setOutput('s4-out', finding)
      } catch (error) {
        // A thrown probe must not take the other spikes down with it, and it
        // must not be reported as a failing result either — those are different
        // findings.
        record('S4_skeletonSelectors', { verdict: 'errored', error: String(error), stack: String(error && error.stack) })
        setState('s4-state', `errored: ${String(error)}`)
      }
    })())

    auto.push((async () => {
      setState('s67-state', 'running…')
      try {
        const finding = await spikeBoundaries()
        record('S6_shadowBoundary', finding.S6_shadowBoundary)
        record('S7_scopedAttributes', finding.S7_scopedAttributes)
        setState('s67-state', `S6 ${finding.S6_shadowBoundary.verdict} · S7 ${finding.S7_scopedAttributes.verdict}`)
        setOutput('s67-out', finding)
      } catch (error) {
        record('S6_shadowBoundary', { verdict: 'errored', error: String(error) })
        setState('s67-state', `errored: ${String(error)}`)
      }
    })())

    armPointerTravelProbe()

    await Promise.all(auto)

    // Advertise completion so the runner can write the report without guessing.
    window.__spikeResults = results
    window.__spikeComplete = true
    console.log(`[spike] automated runs complete: ${Object.keys(results).length} findings`)
  }

  // Exposed so the runner can drive a re-run after a change without reloading.
  window.__runSpikes = runAll

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAll, { once: true })
  } else {
    void runAll()
  }
})()
