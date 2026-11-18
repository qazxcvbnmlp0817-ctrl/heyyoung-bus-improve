(function () {
  'use strict';

  var input = document.getElementById('stop-input');
  var clearBtn = document.getElementById('clear-btn');
  var list = document.getElementById('suggestions');
  var results = document.getElementById('results');
  var dirButtons = document.querySelectorAll('.dir-toggle button');

  var routes = [];
  var stops = [];          // [{ key, names: [원래 이름들], search: [정규화된 이름들] }]
  var stopByName = {};     // 원래 정류장 이름 -> stop
  var state = { dir: '등교', stop: null, active: -1, shown: [] };

  // 같은 정류장 묶기용: 띄어쓰기를 없애고 끝에 붙은 "건너편", "앞", "승강장" 같은 말을 뗀다
  function stopKey(s) {
    var k = String(s).replace(/\s+/g, '');
    var prev;
    do {
      prev = k;
      k = k.replace(/(버스승강장|승강장|정류장|정류소|건너편|맞은편|앞|옆)$/, '');
    } while (k !== prev && k);
    return k || prev;
  }

  // 검색용: 묶기 규칙에 더해 기호와 표기 차이도 무시한다
  function normalize(s) {
    return stopKey(s)
      .toLowerCase()
      .replace(/Ⓐ/g, '아파트')
      .replace(/센타/g, '센터')
      .replace(/[_·.,()´'"\-]/g, '');
  }

  function compact(s) {
    return String(s).toLowerCase().replace(/[\s_·.,()´'"\-]/g, '');
  }

  // 화면에 보이는 정류장 이름: 밑줄(_)을 " · "로
  function displayName(s) {
    return String(s).replace(/\s*_\s*/g, ' · ');
  }

  // 시간표에 시간이 없는 정류장을 채울 때 쓰는 이동 시간(분).
  // 광주 정류장 간격과 도림↔에너지밸리 35분은 시간표 평균, 나머지는 임의로 정한 값이다.
  var ESTIMATE = {
    stopGap: { '광주': 5, '목포': 3, '해남': 7, '캠퍼스 간': 5 },        // 지역 안 정류장 사이
    campusLeg: { '광주': 50, '목포': 25, '해남': 25, '캠퍼스 간': 15 },  // 도림캠퍼스 ↔ 지역 정류장
    nearCampus: { '무안우체국': 10, '남악애시앙': 15, '옥암주공': 20,     // 도림캠퍼스와 가까운 정류장
                  '고막원': 25, '함평역': 25 },                          // (이름 앞부분으로 찾음)
    energyValleyLeg: 25,                                                // 에너지밸리캠퍼스 ↔ 광주 정류장
    campusToCampus: 35,                                                 // 도림캠퍼스 ↔ 에너지밸리캠퍼스
    defaultGap: 5,
    defaultCampusLeg: 30
  };

  function isDorim(name) { return /도림캠퍼스/.test(name); }
  function isEnergyValley(name) { return /에너지밸리캠퍼스/.test(name); }

  function legMinutes(area, a, b) {
    var dorim = isDorim(a) || isDorim(b);
    var ev = isEnergyValley(a) || isEnergyValley(b);
    if (dorim && ev) return ESTIMATE.campusToCampus;
    if (ev) return ESTIMATE.energyValleyLeg;
    if (dorim) {
      var other = stopKey(isDorim(a) ? b : a);
      var near = Object.keys(ESTIMATE.nearCampus).filter(function (k) { return other.indexOf(k) === 0; })[0];
      if (near) return ESTIMATE.nearCampus[near];
      return ESTIMATE.campusLeg[area] || ESTIMATE.defaultCampusLeg;
    }
    return ESTIMATE.stopGap[area] || ESTIMATE.defaultGap;
  }

  function toMinutes(t) {
    var p = t.split(':');
    return +p[0] * 60 + +p[1];
  }

  function toClock(min) {
    min = ((Math.round(min) % 1440) + 1440) % 1440;
    var h = Math.floor(min / 60), m = min % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // 노선의 정류장마다 { min, est } 를 만든다. est가 true면 계산한 예상값
  function routeTimes(r) {
    if (r._times) return r._times;
    var times = r.stops.map(function (s) {
      return s[1] ? { min: toMinutes(s[1]), est: false } : null;
    });
    if (!times[0]) times[0] = { min: toMinutes(r.time), est: false };

    var legs = r.stops.map(function (s, i) {
      return i === 0 ? 0 : legMinutes(r.area, r.stops[i - 1][0], s[0]);
    });

    var last = 0;
    for (var i = 1; i < times.length; i++) {
      if (!times[i]) continue;
      // 앞뒤 시간이 모두 있는 구간: 이동 시간 비율대로 나눈다
      var total = 0, j;
      for (j = last + 1; j <= i; j++) total += legs[j];
      var span = times[i].min - times[last].min, acc = 0;
      for (j = last + 1; j < i; j++) {
        acc += legs[j];
        times[j] = { min: times[last].min + Math.round(span * acc / total), est: true };
      }
      last = i;
    }
    // 마지막으로 시간이 있는 정류장 뒤: 이동 시간을 더해 나간다
    for (i = last + 1; i < times.length; i++) {
      times[i] = { min: times[i - 1].min + legs[i], est: true };
    }

    r._times = times;
    return times;
  }

  function clockText(t) {
    return (t.est ? '약 ' : '') + toClock(t.min);
  }

  var NOTE_REPLACEMENT ='운행 요일·경유지는 학생지원과 공지를 확인하세요';

  // PDF 쪽수·표기 차이를 말하는 문장은 안내 문구로 바꾼다
  function displayNote(note) {
    var out = [];
    String(note).split(/(?<=\.)\s+/).forEach(function (sentence) {
      var text = /PDF|\d+쪽|표기가 다름/.test(sentence) ? NOTE_REPLACEMENT : sentence;
      if (out.indexOf(text) === -1) out.push(text);
    });
    return out.join(' ');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function buildStops(data) {
    var aliases = data.stopAliases || {};
    var keyToStop = {};      // stopKey -> 정류장 묶음

    function addSearch(stop, name) {
      [normalize(name), compact(name)].forEach(function (n) {
        if (n && stop.search.indexOf(n) === -1) stop.search.push(n);
      });
    }

    // 별칭 그룹 먼저: 별칭의 대표 이름을 그대로 쓴다
    Object.keys(aliases).forEach(function (key) {
      var stop = keyToStop[stopKey(key)] || { key: key, names: [], search: [] };
      [key].concat(aliases[key]).forEach(function (name) {
        keyToStop[stopKey(name)] = stop;
        addSearch(stop, name);
      });
      stop.fromAlias = true;
    });

    routes.forEach(function (r) {
      r.stops.forEach(function (s) {
        var name = s[0];
        if (stopByName[name]) return;
        var k = stopKey(name);
        var stop = keyToStop[k];
        if (!stop) stop = keyToStop[k] = { key: null, names: [], search: [] };
        if (stop.names.indexOf(name) === -1) stop.names.push(name);
        addSearch(stop, name);
        stopByName[name] = stop;
      });
    });

    // 실제로 노선에 나오는 정류장만 남기고 대표 이름을 정한다
    stops = [];
    Object.keys(keyToStop).forEach(function (k) {
      var st = keyToStop[k];
      if (!st.names.length || stops.indexOf(st) !== -1) return;
      if (!st.fromAlias) {
        // 꾸밈말이 없는 이름이 있으면 그 이름, 없으면 꾸밈말을 뗀 이름
        st.key = st.names.filter(function (n) { return n.replace(/\s+/g, '') === k; })[0] || k;
      }
      stops.push(st);
    });
  }

  function countFor(stop, dir) {
    return routes.filter(function (r) {
      return r.dir === dir && r.stops.some(function (s) { return stopByName[s[0]] === stop; });
    }).length;
  }

  function findStops(query) {
    var q = normalize(query);
    if (!q) return [];
    var scored = [];
    stops.forEach(function (st) {
      var best = Infinity;
      st.search.forEach(function (n) {
        var i = n.indexOf(q);
        if (i === -1) return;
        var score = i === 0 ? 0 : 1;      // 앞부분이 맞으면 위로
        if (n === q) score = -1;
        best = Math.min(best, score);
      });
      if (best !== Infinity) scored.push({ stop: st, score: best });
    });
    scored.sort(function (a, b) {
      return a.score - b.score || a.stop.key.localeCompare(b.stop.key, 'ko');
    });
    return scored.slice(0, 12).map(function (x) { return x.stop; });
  }

  function highlight(name, query) {
    var q = query.trim();
    var i = q ? name.indexOf(q) : -1;
    if (i === -1) return escapeHtml(name);
    return escapeHtml(name.slice(0, i)) + '<mark>' + escapeHtml(name.slice(i, i + q.length)) +
      '</mark>' + escapeHtml(name.slice(i + q.length));
  }

  function renderSuggestions() {
    var query = input.value;
    clearBtn.hidden = !query;
    if (!query.trim()) return closeSuggestions();

    state.shown = findStops(query);
    state.active = -1;

    if (!state.shown.length) {
      list.innerHTML = '<li class="s-empty" role="option" aria-disabled="true">일치하는 정류장이 없어요</li>';
    } else {
      list.innerHTML = state.shown.map(function (st, i) {
        var sub = ['등교', '하교'].map(function (dir) {
          var n = countFor(st, dir);
          return n ? dir + ' ' + n + '대' : '';
        }).filter(Boolean).join(' · ');
        return '<li role="option" id="opt-' + i + '" data-i="' + i + '">' +
          '<div class="s-name">' + highlight(displayName(st.key), query) + '</div>' +
          '<div class="s-sub">' + escapeHtml(sub) + '</div></li>';
      }).join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closeSuggestions() {
    list.hidden = true;
    list.innerHTML = '';
    state.shown = [];
    state.active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function moveActive(step) {
    if (!state.shown.length) return;
    state.active = (state.active + step + state.shown.length) % state.shown.length;
    Array.prototype.forEach.call(list.children, function (li, i) {
      li.setAttribute('aria-selected', i === state.active ? 'true' : 'false');
      if (i === state.active) li.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', 'opt-' + state.active);
  }

  function selectStop(stop) {
    state.stop = stop;
    input.value = displayName(stop.key);
    clearBtn.hidden = false;
    closeSuggestions();
    input.blur();
    renderResults();
  }

  function setDir(dir) {
    state.dir = dir;
    Array.prototype.forEach.call(dirButtons, function (b) {
      var on = b.getAttribute('data-dir') === dir;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (state.stop) renderResults();
  }

  function routeTitle(r) {
    return r.area + ' ' + r.line + ' ' + r.no + '호차';
  }

  function renderResults() {
    var stop = state.stop;
    var dir = state.dir;

    var items = [];
    routes.forEach(function (r) {
      if (r.dir !== dir) return;
      for (var i = 0; i < r.stops.length; i++) {
        if (stopByName[r.stops[i][0]] === stop) {
          items.push({ route: r, index: i, time: routeTimes(r)[i] });
          break;
        }
      }
    });

    // 이 정류장 시각(예상값 포함) 순으로 정렬
    items.sort(function (a, b) {
      return a.time.min - b.time.min ||
        a.route.area.localeCompare(b.route.area, 'ko') || a.route.no - b.route.no;
    });

    var head = '<div class="result-head"><h2>' + escapeHtml(displayName(stop.key)) + '</h2>' +
      '<p>' + dir + ' 버스 ' + items.length + '대 · 시간순</p>' +
      '<p class="legend">‘약’이 붙은 시간은 시간표의 앞뒤 시간과 평균 이동 시간으로 계산한 예상값이에요.</p></div>';

    if (!items.length) {
      var other = dir === '등교' ? '하교' : '등교';
      var otherCount = countFor(stop, other);
      results.innerHTML = head + '<div class="empty"><p>이 정류장을 지나는 ' + dir + ' 버스가 없어요.</p>' +
        (otherCount ? '<button type="button" data-switch="' + other + '">' + other + ' 버스 ' +
          otherCount + '대 보기</button>' : '') + '</div>';
      return;
    }

    results.innerHTML = head + items.map(renderCard).join('');
  }

  function renderCard(item) {
    var r = item.route;
    var first = displayName(r.stops[0][0]);
    var last = displayName(r.stops[r.stops.length - 1][0]);

    var times = routeTimes(r);
    var t = item.time;
    var timeHtml = '<div class="time' + (t.est ? ' est' : '') + '"><strong>' + clockText(t) +
      '</strong><span>' + (t.est ? '이 정류장 · 예상' : '이 정류장') + '</span></div>';

    // 예상 소요 시간: 등교는 여기서 종점(학교)까지, 하교는 출발지(학교)에서 여기까지
    var lastIndex = r.stops.length - 1;
    var from = item.index, to = lastIndex, label;
    if (r.dir === '하교' && item.index > 0) { from = 0; to = item.index; }
    if (from === to) from = 0;
    var a = times[from], b = times[to];
    var est = a.est || b.est;
    if (to === lastIndex && from === item.index) {
      label = displayName(r.stops[to][0]) + ' 도착 ' + clockText(b);
    } else {
      label = displayName(r.stops[from][0]) + ' 출발 ' + clockText(a);
    }
    var duration = '<p class="duration"><span>' + escapeHtml(label) + '</span>' +
      '<b>' + (est ? '약 ' : '') + (b.min - a.min) + '분 소요</b></p>';

    var chips = '<span class="chip">' + escapeHtml(r.days) + '</span>';
    if (r.n > 1) chips += '<span class="chip">' + r.n + '대 운행</span>';
    if (t.est || est) chips += '<span class="chip warn">예상 시간 포함</span>';

    var note = r.note ? '<p class="note"><b>비고</b>' + escapeHtml(displayNote(r.note)) + '</p>' : '';

    var stopList = r.stops.map(function (s, i) {
      return '<li' + (i === item.index ? ' class="here"' : '') + '>' + escapeHtml(displayName(s[0])) +
        '<span class="t' + (times[i].est ? ' est' : '') + '">' + clockText(times[i]) + '</span></li>';
    }).join('');

    return '<article class="card">' +
      '<div class="card-top"><div>' +
        '<h3 class="route-name">' + escapeHtml(routeTitle(r)) + '</h3>' +
        '<p class="route-sub">' + escapeHtml(first) + ' → ' + escapeHtml(last) + '</p>' +
      '</div>' + timeHtml + '</div>' + duration +
      '<div class="chips">' + chips + '</div>' + note +
      '<details><summary>운행 경로 보기 (' + r.stops.length + '곳)</summary>' +
        '<ol class="stop-list">' + stopList + '</ol></details>' +
      '</article>';
  }

  // 이벤트
  input.addEventListener('input', renderSuggestions);
  input.addEventListener('focus', function () { if (input.value.trim()) renderSuggestions(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Escape') { closeSuggestions(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      var pick = state.shown[state.active >= 0 ? state.active : 0];
      if (pick) selectStop(pick);
    }
  });

  list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 입력창 blur 방지
  list.addEventListener('click', function (e) {
    var li = e.target.closest('li[data-i]');
    if (li) selectStop(state.shown[+li.getAttribute('data-i')]);
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.search')) closeSuggestions();
  });

  clearBtn.addEventListener('click', function () {
    input.value = '';
    clearBtn.hidden = true;
    closeSuggestions();
    input.focus();
  });

  Array.prototype.forEach.call(dirButtons, function (b) {
    b.addEventListener('click', function () { setDir(b.getAttribute('data-dir')); });
  });

  results.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-switch]');
    if (b) setDir(b.getAttribute('data-switch'));
  });

  // 데이터 불러오기
  fetch('bus-data.json')
    .then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    })
    .then(function (data) {
      routes = data.routes || [];
      buildStops(data);
      if (data.contact) document.getElementById('contact').textContent = data.contact;
    })
    .catch(function () {
      results.innerHTML = '<p class="error">버스 정보를 불러오지 못했어요.<br>' +
        '파일을 더블클릭해서 열면 브라우저가 막을 수 있어요. 웹 서버로 열어 주세요.</p>';
    });
})();
