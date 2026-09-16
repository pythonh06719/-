import { expect, test } from '@playwright/test';

/**
 * 浏览器级验证（简历可展示）：
 * 1. 落地页核心元素 + 免注册热量计算闭环
 * 2. 关键a11y/隐私承诺可见
 */

test.describe('落地页与免注册计算器', () => {
  test('页面加载且标题正确', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/轻生活/);
  });

  test('免注册热量计算闭环：输入 → 计算出结果', async ({ page }) => {
    await page.goto('/');

    // 计算器表单（免注册试用计算器）
    const gender = page.getByLabel(/性别/).or(page.locator('select').first());
    await gender.selectOption({ index: 0 });

    const age = page.getByLabel(/年龄/).or(page.getByRole('spinbutton').first());
    await age.fill('28');

    const height = page.getByLabel(/身高/);
    await height.fill('175');

    const weight = page.getByLabel(/体重/);
    await weight.fill('70');

    // 提交计算
    await page.getByRole('button', { name: /计算/ }).click();

    // 断言：出现热量结果数字（BMR/TDEE 均为千位数级别）
    await expect(page.getByText(/\d{3,4}\s*(kcal|千卡|大卡)/).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test('隐私承诺与免责声明可见（数据主权承诺）', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/隐私|数据|免责/).first()).toBeVisible();
  });
});
