import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MomentsView } from '../src/views/MomentsView.js';
import { fakeMomentsClient, moment } from './fakes.js';

/**
 * JIN-56 验收:朋友圈。
 *
 * 「信息流能刷 / 点赞评论收藏可用」——这几条断言就是那句验收标准的可执行版本。
 */
function setup(opts: Parameters<typeof fakeMomentsClient>[0] = {}) {
  const fake = fakeMomentsClient(opts);
  const view = render(<MomentsView client={fake.client} companyId="c1" />);
  return { fake, view, user: userEvent.setup() };
}

describe('信息流', () => {
  it('渲染 AI 员工主动发的动态:作者、角色、正文、标签、方法包卡片', async () => {
    setup({
      feed: [
        moment({
          content: '已更新『高净值场景开头』方法 v2.1,覆盖公司老板、股权纠纷',
          tags: ['抖音趋势', '内容建议'],
          card: {
            type: 'method_pack',
            title: '高净值场景开头',
            version: 'v2.1',
            summary: '3 个开头模板',
            items: ['公司老板', '股权纠纷'],
          },
        }),
      ],
    });

    expect(await screen.findByText(/高净值场景开头.*方法 v2\.1/)).toBeTruthy();
    // 圈到这条动态里查:侧栏也有「文案编导」
    const post = screen.getByRole('article', { name: '文案编导 的动态' });
    expect(within(post).getByText('#抖音趋势')).toBeTruthy();
    // 卡片是这条动态的价值本体,不是装饰 —— 它必须真的渲染出来
    expect(within(post).getByText('方法包')).toBeTruthy();
    expect(within(post).getByText('v2.1')).toBeTruthy();
    expect(within(post).getByText('股权纠纷')).toBeTruthy();
  });

  it('按分类切 tab:只请求该分类,不在前端瞎过滤', async () => {
    const { fake, user } = setup({
      feed: [
        moment({ id: 'a', category: 'ai_update', content: '员工动态' }),
        moment({ id: 'b', category: 'industry', content: '行业资讯一条' }),
      ],
    });

    await screen.findByText('员工动态');
    await user.click(screen.getByRole('button', { name: '行业资讯' }));

    await waitFor(() => expect(screen.getByText('行业资讯一条')).toBeTruthy());
    expect(screen.queryByText('员工动态')).toBeNull();
    // 分类过滤必须是服务端的事:前端过滤会让「加载更多」在分页时漏行
    expect(fake.client.listFeed).toHaveBeenCalledWith('c1', { category: 'industry' });
  });

  it('加载更多:用游标续page,不重不漏', async () => {
    const feed = Array.from({ length: 3 }, (_, i) =>
      moment({
        id: `m${i}`,
        content: `第 ${i} 条`,
        createdAt: new Date(1_700_000_000_000 - i * 1000).toISOString(),
      }),
    );
    const { user } = setup({ feed, pageSize: 2 });

    await screen.findByText('第 0 条');
    expect(screen.queryByText('第 2 条')).toBeNull();

    await user.click(screen.getByRole('button', { name: '加载更多' }));

    await waitFor(() => expect(screen.getByText('第 2 条')).toBeTruthy());
    expect(screen.getAllByText('第 0 条')).toHaveLength(1); // 不重
  });

  it('空信息流给的是「员工还没发」,不是报错', async () => {
    setup({ feed: [] });
    expect(await screen.findByText(/还没有动态/)).toBeTruthy();
  });
});

describe('点赞 / 收藏 / 评论', () => {
  it('点赞:立刻变色并 +1(乐观),不等服务端往返', async () => {
    const { fake, user } = setup({ feed: [moment({ likeCount: 2 })] });

    const like = await screen.findByRole('button', { name: '点赞' });
    await user.click(like);

    const on = screen.getByRole('button', { name: '取消点赞' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.textContent).toContain('3');
    await waitFor(() => expect(fake.liked.has('mo-1')).toBe(true));
  });

  it('再点一次取消赞,计数回到原值(不会越点越多)', async () => {
    const { fake, user } = setup({ feed: [moment({ likeCount: 2 })] });

    await user.click(await screen.findByRole('button', { name: '点赞' }));
    await user.click(screen.getByRole('button', { name: '取消点赞' }));

    const off = screen.getByRole('button', { name: '点赞' });
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(off.textContent).toContain('2');
    await waitFor(() => expect(fake.liked.has('mo-1')).toBe(false));
  });

  it('点赞失败:回滚计数并告诉用户 —— 不能静默装作成功', async () => {
    const { fake, user } = setup({ feed: [moment({ likeCount: 2 })] });
    fake.breakNext();

    await user.click(await screen.findByRole('button', { name: '点赞' }));

    await waitFor(() => expect(screen.getByText('操作失败,请重试')).toBeTruthy());
    const back = screen.getByRole('button', { name: '点赞' });
    expect(back.getAttribute('aria-pressed')).toBe('false');
    expect(back.textContent).toContain('2');
  });

  it('收藏:落进知识库,状态跟手翻转', async () => {
    const { fake, user } = setup({ feed: [moment()] });

    await user.click(await screen.findByRole('button', { name: '收藏' }));

    expect(screen.getByRole('button', { name: '取消收藏' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(fake.favorited.has('mo-1')).toBe(true));
  });

  it('评论:展开 → 发送 → 出现在列表里,计数 +1', async () => {
    const { user } = setup({ feed: [moment({ commentCount: 0 })] });

    await user.click(await screen.findByRole('button', { name: '评论' }));
    const box = screen.getByRole('region', { name: '评论' });
    expect(within(box).getByText('还没有评论。')).toBeTruthy();

    await user.click(screen.getByLabelText('写评论'));
    await user.keyboard('这个方法很实用{Enter}');

    await waitFor(() => expect(screen.getByText('这个方法很实用')).toBeTruthy());
    expect(screen.getByRole('button', { name: '评论' }).textContent).toContain('1');
  });
});

describe('侧栏', () => {
  it('显示常去的 AI 员工', async () => {
    setup({ feed: [moment()] });
    const side = await screen.findByRole('complementary', { name: '侧栏' });
    expect(within(side).getByText('文案编导')).toBeTruthy();
    expect(within(side).getByText('3 条')).toBeTruthy();
  });
});
