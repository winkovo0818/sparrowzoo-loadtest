// k6 阶梯加压脚本：验证 api.sparrowzoo.com 的崩溃点与宕机恢复
// 本地运行:  k6 run sparrowzoo_crash_test.js
// 云端运行:  k6 cloud sparrowzoo_crash_test.js   (或导入阿里云 PTS)
//
// 设计说明:
//   - 用 arrival-rate(恒定到达率) 而不是 VU 迭代，压力不随响应变慢而衰减
//     (ab/线程模型在服务变慢时压力会自动下降，永远压不崩，这是常见误区)
//   - 阶梯: 50 -> 200 -> 500 -> 1000 -> 2000 req/s, 每阶 60s
//   - 每阶段结束输出可用率，方便画「压力-可用率」曲线找拐点

import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = 'https://api.sparrowzoo.com';

const okRate = new Rate('business_ok');
const connFail = new Counter('connection_failures');
const latency = new Trend('response_latency', true);

export const options = {
  discardResponseBodies: true,
  thresholds: { business_ok: ['rate>0'] },  // 永不因阈值中断，记录到底
  scenarios: {
    ramp_to_death: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 500,
      maxVUs: 20000,
      stages: [
        { target: 50, duration: '60s' },    // 已知安全区
        { target: 200, duration: '60s' },   // 已知拐点附近
        { target: 500, duration: '60s' },   // 已知崩溃区
        { target: 1000, duration: '60s' },  // 深度过载
        { target: 2000, duration: '120s' }, // 持续碾压: 观察是否全下线
        { target: 0, duration: '10s' },     // 骤停: 观察恢复
        { target: 50, duration: '60s' },    // 低负载: 验证自愈后延迟
      ],
    },
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/captcha`, { timeout: '10s' });
  latency.add(res.timings.duration);
  if (res.status === 0) {
    connFail.add(1);
    okRate.add(false);
  } else {
    const isJpeg = res.body && res.body.length > 500;
    okRate.add(res.status === 200 && isJpeg);
  }
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    '/tmp/k6_summary.json': JSON.stringify(data),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const lines = [
    '===== sparrowzoo crash test summary =====',
    `total requests   : ${m.http_reqs ? m.http_reqs.count : 0}`,
    `business ok rate : ${(m.business_ok ? m.business_ok.value * 100 : 0).toFixed(1)}%`,
    `conn failures    : ${m.connection_failures ? m.connection_failures.count : 0}`,
    `p50 latency      : ${m.http_req_duration ? m.http_req_duration['p(50)'].toFixed(0) : '-'}ms`,
    `p99 latency      : ${m.http_req_duration ? m.http_req_duration['p(99)'].toFixed(0) : '-'}ms`,
  ];
  return lines.join('\n') + '\n';
}
