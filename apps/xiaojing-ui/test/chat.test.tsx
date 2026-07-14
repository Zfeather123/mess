import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatView } from '../src/views/ChatView.js';
import { conversation, DOCTOR, fakeBridge, fakeClient, message, WRITER } from './fakes.js';

/**
 * JIN-52 的验收:群聊能收发、卡片能渲染能操作、@能路由、实时推送不丢消息、
 * 手机上能用。每条验收在这里都有一个能跑的用例。
 */

/** 取出 bridge.runAgent 第一次被调用时的入参 —— 「活派给谁了」。 */
function agentRunCall(bridge: ReturnType<typeof fakeBridge>) {
  const calls = (bridge.runAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]![0] as { runId: string; agent: { id: string; name: string } };
}

function setup(opts: Parameters<typeof fakeClient>[0] = {}) {
  const bridge = fakeBridge('desktop');
  const fake = fakeClient(opts);
  const view = render(<ChatView bridge={bridge} client={fake.client} tasks={[
    { id: 't1', title: '发布《彩礼返还》口播', status: 'doing', owner: '文案编导' },
    { id: 't2', title: '复盘上周数据', status: 'done', owner: '账号诊断师' },
  ]} />);
  return { bridge, fake, view, user: userEvent.setup() };
}

describe('群聊收发', () => {
  it('用户发消息:先乐观上屏,服务端确认后不冒双份', async () => {
    const { user, fake } = setup({ history: [message(1, { body: '早' })] });
    await waitFor(() => expect(screen.getByText('早')).toBeTruthy());

    await user.click(screen.getByLabelText(/消息输入框/));
    await user.keyboard('今天出个选题{Enter}');

    // 乐观气泡立刻在,不等网络
    expect(screen.getByText('今天出个选题')).toBeTruthy();
    await waitFor(() => expect(fake.sent).toHaveLength(1));
    // 服务端那条按 clientNonce 顶替本地那条 —— 只有一条,不是两条
    await waitFor(() => expect(screen.getAllByText('今天出个选题')).toHaveLength(1));
  });

  it('AI 员工主动汇报:服务端推过来就上屏,用户没做任何操作', async () => {
    const { fake } = setup({ history: [message(1)] });
    await waitFor(() => expect(screen.getByText('第 1 条')).toBeTruthy());

    await act(async () => {
      fake.push(message(2, { body: '刚发的那条完播率 42%,比上周高 9 个点' }));
    });
    await waitFor(() => expect(screen.getByText(/完播率 42%/)).toBeTruthy());
  });

  it('发送失败给重发入口 —— 不能让消息静悄悄消失', async () => {
    const { user, fake } = setup({ history: [message(1)] });
    await waitFor(() => expect(screen.getByText('第 1 条')).toBeTruthy());

    fake.breakNextSend();
    await user.click(screen.getByLabelText(/消息输入框/));
    await user.keyboard('这条会失败{Enter}');

    const retry = await screen.findByRole('button', { name: /发送失败,重发/ });
    await user.click(retry);
    await waitFor(() => expect(fake.sent.some((s) => s.body === '这条会失败')).toBe(true));
  });
});

describe('实时推送:不丢消息、断线补齐', () => {
  it('订阅时带上水位线 sinceSeq —— 服务端据此重放漏掉的', async () => {
    const { fake } = setup({ history: [message(1), message(2), message(3)] });
    await waitFor(() => expect(fake.subscribedSince).toEqual([3]));
  });

  it('断线期间产生的消息:直播先到 seq 6 → 识别出洞 → HTTP 补回 4、5,顺序不乱', async () => {
    const { fake } = setup({ history: [message(1), message(2), message(3)] });
    await waitFor(() => expect(screen.getByText('第 3 条')).toBeTruthy());

    // 断线期间落库的 4、5(客户端没收到),重连后先收到直播的 6
    fake.landSilently(message(4, { body: '断线时的第 4 条' }));
    fake.landSilently(message(5, { body: '断线时的第 5 条' }));
    await act(async () => {
      fake.push(message(6, { body: '重连后的第 6 条' }));
    });

    await waitFor(() => {
      expect(screen.getByText('断线时的第 4 条')).toBeTruthy();
      expect(screen.getByText('断线时的第 5 条')).toBeTruthy();
    });

    // 补回来的必须排在 6 前面 —— 时间顺序错乱在群聊里是致命体验问题
    const seqs = within(screen.getByTestId('thread'))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-seq'))
      .filter(Boolean);
    expect(seqs).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('同一条消息重复推送(重连重放)只渲染一条', async () => {
    const { fake } = setup({ history: [message(1)] });
    await act(async () => {
      fake.push(message(2, { body: '重放的' }));
      fake.push(message(2, { body: '重放的' }));
    });
    await waitFor(() => expect(screen.getAllByText('重放的')).toHaveLength(1));
  });
});

describe('@提及路由到指定 AI 员工', () => {
  it('@选择器:输入 @ 弹菜单,键盘选中后插入带 id 的标记', async () => {
    const { user, bridge } = setup({ history: [message(1)] });
    await waitFor(() => expect(screen.getByText('第 1 条')).toBeTruthy());

    await user.click(screen.getByLabelText(/消息输入框/));
    await user.keyboard('@诊断');

    const menu = await screen.findByRole('listbox', { name: /选择要 @ 的成员/ });
    expect(within(menu).getByText('账号诊断师')).toBeTruthy();

    await user.keyboard('{Enter}'); // 选中高亮项
    await user.keyboard('看下最近掉粉{Enter}'); // 发送

    await waitFor(() => expect(bridge.runAgent).toHaveBeenCalled());
    const call = agentRunCall(bridge);
    // 路由到被 @ 的那位,不是群里随便一位
    expect(call.agent.id).toBe(DOCTOR);
    expect(call.agent.id).not.toBe(WRITER);
  });

  it('/ 快捷指令:自动 @上负责的员工并填好模板', async () => {
    const { user, fake } = setup({ history: [message(1)] });
    await waitFor(() => expect(screen.getByText('第 1 条')).toBeTruthy());

    await user.click(screen.getByLabelText(/消息输入框/));
    await user.keyboard('/诊断');

    const menu = await screen.findByRole('listbox', { name: '快捷指令' });
    expect(within(menu).getByText('/诊断')).toBeTruthy();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}'); // 直接发出去

    await waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]!.body).toContain(`(agent:${DOCTOR})`);
    expect(fake.sent[0]!.body).toContain('诊断一下我最近 7 天的数据');
  });

  it('@ 高亮:正文里的标记渲染成人类可读的 @名字', async () => {
    setup({ history: [message(1, { body: '@[文案编导](agent:agent-writer) 看下这条' })] });
    await waitFor(() => expect(screen.getByText('@文案编导')).toBeTruthy());
    // 不能把原始标记漏给用户看
    expect(screen.queryByText(/\(agent:agent-writer\)/)).toBeNull();
  });
});

describe('卡片消息', () => {
  const topicCard = message(2, {
    kind: 'card',
    cardType: 'topic_list',
    body: null,
    cardPayload: {
      title: '本周 5 个选题',
      topics: [
        { title: '彩礼能不能要回来', hook: '订婚三个月分手' },
        { title: '离婚冷静期怎么算', hook: '30 天里能反悔吗' },
      ],
    },
  });

  it('渲染选题卡片的结构化内容', async () => {
    setup({ history: [topicCard] });
    const card = await screen.findByRole('article', { name: /选题卡片/ });
    expect(within(card).getByText('本周 5 个选题')).toBeTruthy();
    expect(within(card).getByText('彩礼能不能要回来')).toBeTruthy();
    expect(within(card).getByText(/订婚三个月分手/)).toBeTruthy();
  });

  it('「复制」把卡片内容写进剪贴板', async () => {
    const { user } = setup({ history: [topicCard] });
    // 必须在 userEvent.setup() 之后再替换 —— user-event 自己会往 navigator 上装一个剪贴板桩
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const card = await screen.findByRole('article', { name: /选题卡片/ });
    await user.click(within(card).getByRole('button', { name: '复制' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toContain('1. 彩礼能不能要回来');
    await waitFor(() => expect(within(card).getByRole('button', { name: '已复制' })).toBeTruthy());
  });

  it('「继续调整」把上下文回填输入框,并 @回卡片的作者', async () => {
    const { user } = setup({ history: [topicCard] });
    const card = await screen.findByRole('article', { name: /选题卡片/ });
    await user.click(within(card).getByRole('button', { name: '继续调整' }));

    const input = screen.getByLabelText(/消息输入框/) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(input.value).toContain(`(agent:${WRITER})`); // 卡片是文案编导发的
      expect(input.value).toContain('本周 5 个选题');
    });
  });

  it('诊断卡片渲染指标和涨跌', async () => {
    setup({
      history: [
        message(2, {
          kind: 'card',
          cardType: 'diagnosis',
          body: null,
          senderAgentId: DOCTOR,
          senderName: '账号诊断师',
          cardPayload: {
            title: '近 7 天诊断',
            metrics: [{ label: '完播率', value: '42%', delta: '+9pt' }],
            summary: '开头 3 秒的钩子起作用了。',
          },
        }),
      ],
    });
    const card = await screen.findByRole('article', { name: /账号诊断卡片/ });
    expect(within(card).getByText('完播率')).toBeTruthy();
    expect(within(card).getByText('+9pt')).toBeTruthy();
  });
});

describe('会话列表与未读', () => {
  it('未读数显示为红点,@我 显示为「@」', async () => {
    const { fake } = setup({
      conversations: [
        conversation({ id: 'c-a', title: '我的 AI 团队', unread: 3, mentioned: false }),
        conversation({ id: 'c-b', title: '文案编导', kind: 'direct', unread: 1, mentioned: true }),
      ],
      history: [message(1)],
    });
    await waitFor(() => expect(fake.client.listConversations).toHaveBeenCalled());

    expect((await screen.findByLabelText('3 条未读')).textContent).toBe('3');
    expect((await screen.findByLabelText(/有人 @ 了你,1 条未读/)).textContent).toBe('@');
  });

  it('点开会话就把红点清掉', async () => {
    const { user } = setup({
      conversations: [
        conversation({ id: 'c-a', title: '我的 AI 团队', unread: 0 }),
        conversation({ id: 'c-b', title: '账号诊断师', kind: 'direct', unread: 5 }),
      ],
      history: [message(1)],
    });
    expect(await screen.findByLabelText('5 条未读')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /账号诊断师/ }));
    await waitFor(() => expect(screen.queryByLabelText('5 条未读')).toBeNull());
  });
});

describe('右侧面板 + 移动端', () => {
  it('今日任务进度和成员在线状态', async () => {
    setup({ history: [message(1)] });
    const panel = await screen.findByRole('complementary', { name: /今日任务与团队状态/ });
    expect(within(panel).getByRole('progressbar', { name: /完成度 50%/ })).toBeTruthy();
    // 「文案编导」在面板里出现两次(任务负责人 + 团队成员),两处都该有
    expect(within(panel).getAllByText('文案编导').length).toBeGreaterThan(0);
  });

  it('AI 员工干活时,面板上的状态变成「干活中」', async () => {
    const { user, bridge } = setup({ history: [message(1)] });
    await waitFor(() => expect(screen.getByText('第 1 条')).toBeTruthy());

    await user.click(screen.getByLabelText(/消息输入框/));
    await user.paste('@[账号诊断师](agent:agent-doctor) 看下数据');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(bridge.runAgent).toHaveBeenCalled());
    const panel = screen.getByRole('complementary', { name: /今日任务与团队状态/ });
    await waitFor(() => expect(within(panel).getByText('干活中')).toBeTruthy());
  });

  it('手机上一次只显示一栏:点「会话」切到列表,点回来是聊天', async () => {
    const { user } = setup({ history: [message(1)] });
    const app = screen.getByTestId('chat');
    expect(app.dataset['pane']).toBe('chat');

    await user.click(screen.getByRole('button', { name: '会话列表' }));
    expect(app.dataset['pane']).toBe('convs');

    await user.click(screen.getByRole('button', { name: '今日任务与团队状态' }));
    expect(app.dataset['pane']).toBe('panel');
  });
});
