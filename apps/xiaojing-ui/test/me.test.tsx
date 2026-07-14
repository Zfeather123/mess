import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MeView } from '../src/views/MeView.js';
import { AppShell } from '../src/views/AppShell.js';
import { balance, fakeBridge, fakeClient, fakeMeClient, fakeMomentsClient, transaction } from './fakes.js';

/** JIN-56 验收:我的(算力 / 操盘手 / 设置)。 */
function setup(opts: Parameters<typeof fakeMeClient>[0] = {}) {
  const fake = fakeMeClient(opts);
  const view = render(<MeView client={fake.client} companyId="c1" me={{ userId: 'u1' }} />);
  return { fake, view, user: userEvent.setup() };
}

describe('算力余额', () => {
  it('三个数都露出来:可用 / 账面 / 冻结中', async () => {
    setup({ balance: balance({ balancePoints: 10_000, frozenPoints: 1_500, availablePoints: 8_500 }) });

    // 「可用」是主数字 —— 正在跑的 agent 冻结着的额度不能算进去
    expect(await screen.findByText('8500')).toBeTruthy();
    // 明细单独成组:充值面额里也有「10000 点」,不圈定范围会撞上
    const detail = screen.getByRole('group', { name: '算力明细' });
    expect(within(detail).getByText('10000 点')).toBeTruthy();
    // 冻结不露出来的话,用户会看到「余额没变但不够用了」
    expect(within(detail).getByText('1500 点')).toBeTruthy();
    expect(within(detail).getByText('冻结中')).toBeTruthy();
  });

  it('点数按 1 元 = 100 点换算成金额', async () => {
    setup({ balance: balance({ availablePoints: 8_500 }) });
    expect(await screen.findByText(/约 ¥85\.00/)).toBeTruthy();
  });

  it('可用低于阈值时弹「算力不足」横幅', async () => {
    setup({ balance: balance({ availablePoints: 500, lowBalanceThreshold: 1_000 }) });
    expect(await screen.findByText(/可用算力不足/)).toBeTruthy();
  });

  it('没配额度时显示「不限额」而不是 0', async () => {
    setup({ balance: balance({ monthlyQuotaPoints: null, monthlyUsedPoints: 300 }) });
    expect(await screen.findByText('300 点(不限额)')).toBeTruthy();
  });

  it('有额度时给进度条,带无障碍语义', async () => {
    setup({ balance: balance({ monthlyQuotaPoints: 20_000, monthlyUsedPoints: 5_000 }) });
    const bar = await screen.findByRole('progressbar', { name: '本月额度使用' });
    expect(bar.getAttribute('aria-valuenow')).toBe('5000');
    expect(bar.getAttribute('aria-valuemax')).toBe('20000');
  });
});

describe('充值', () => {
  it('只传点数和渠道 —— 前端没有传金额的字段(不给「1 分买 5 万点」留路)', async () => {
    const { fake, user } = setup();

    await user.click(await screen.findByRole('button', { name: /50 元/ }));

    await waitFor(() => expect(fake.orders).toHaveLength(1));
    expect(fake.orders[0]).toEqual({ points: 5_000, channel: 'manual' });
    expect(fake.orders[0]).not.toHaveProperty('amountCents');
  });

  it('建单后如实告诉用户「待确认」,不假装已付款', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: /50 元/ }));
    expect(await screen.findByText(/待确认/)).toBeTruthy();
  });

  it('微信/支付宝没接收银台 —— 按钮是禁用的,不能骗用户去点', async () => {
    setup();
    const wechat = await screen.findByRole('button', { name: /微信支付/ });
    expect(wechat.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /支付宝/ }).hasAttribute('disabled')).toBe(true);
  });
});

describe('用量明细', () => {
  it('每行显示哪个员工、哪个任务、花了多少', async () => {
    setup({ transactions: [transaction({ points: 250, agentName: '文案编导' })] });

    const ledger = await screen.findByRole('region', { name: '用量明细' });
    expect(within(ledger).getByText('文案编导')).toBeTruthy();
    expect(within(ledger).getByText('写一条普法短视频脚本')).toBeTruthy();
    expect(within(ledger).getByLabelText('消耗 250 点')).toBeTruthy();
  });

  it('充值流水是「+」,消耗是「−」', async () => {
    setup({
      transactions: [
        transaction({ id: 't1', direction: 'credit', reason: 'recharge', points: 5_000, agentName: null }),
      ],
    });
    expect(await screen.findByLabelText('增加 5000 点')).toBeTruthy();
  });
});

describe('绑定操盘手', () => {
  it('没绑时给的是引导,不是空白或报错', async () => {
    setup({ coach: { coach: null, boundAt: null } });
    expect(await screen.findByText(/还没有绑定操盘手/)).toBeTruthy();
  });

  it('绑了就显示真人信息 + 私聊入口', async () => {
    setup({
      coach: {
        coach: {
          userId: 'coach-9',
          name: '李操盘',
          title: '资深抖音法律内容操盘手',
          bio: '带过 30 个法律号',
          conversationId: null,
        },
        boundAt: new Date().toISOString(),
      },
    });

    expect(await screen.findByText('李操盘')).toBeTruthy();
    expect(screen.getByText('资深抖音法律内容操盘手')).toBeTruthy();
    expect(screen.getByRole('button', { name: '私聊' })).toBeTruthy();
  });

  it('点私聊:开会话并跳回消息模块', async () => {
    const onOpen = vi.fn();
    const fake = fakeMeClient({
      coach: { coach: { userId: 'coach-9', name: '李操盘' }, boundAt: new Date().toISOString() },
    });
    render(<MeView client={fake.client} companyId="c1" onOpenConversation={onOpen} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '私聊' }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('conv-1'));
  });
});

describe('通知设置', () => {
  it('开关立刻跟手,并把改动写回服务端', async () => {
    const { fake, user } = setup();

    const sw = await screen.findByRole('switch', { name: '合规风险提醒' });
    expect(sw.getAttribute('aria-checked')).toBe('true');

    await user.click(sw);

    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    // 部分更新:只发改动的那一个键,别把另外两个也覆盖一遍
    expect(fake.client.updateNotifications).toHaveBeenCalledWith('c1', { complianceRisk: false });
  });
});

describe('本周概览 / 导出', () => {
  it('显示完成任务 / 生成文案 / 消耗算力 + 员工工作小结', async () => {
    setup();
    const panel = await screen.findByRole('region', { name: '本周使用概览' });
    expect(within(panel).getByText('12')).toBeTruthy();
    expect(within(panel).getByText('5')).toBeTruthy();
    expect(within(panel).getByText('文案编导')).toBeTruthy();
    expect(within(panel).getByText(/7 个任务 · 1800 点/)).toBeTruthy();
  });

  it('导出是个真链接(交给浏览器/桌面壳下载,不把整包读进内存)', async () => {
    setup();
    const link = await screen.findByRole('link', { name: /导出我的数据/ });
    expect(link.getAttribute('href')).toBe('/api/companies/c1/me/export');
  });
});

describe('顶层导航', () => {
  it('消息 / 朋友圈 / 我的 三个 tab 能切,且是同一套代码', async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        bridge={fakeBridge('web')}
        companyId="c1"
        imClient={fakeClient().client}
        momentsClient={fakeMomentsClient().client}
        meClient={fakeMeClient().client}
      />,
    );

    expect(screen.getByTestId('chat')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '朋友圈' }));
    expect(await screen.findByTestId('moments')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '我的' }));
    expect(await screen.findByTestId('me')).toBeTruthy();
  });
});
