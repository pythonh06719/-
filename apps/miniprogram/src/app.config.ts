export default {
  pages: [
    'pages/login/index',
    'pages/onboarding/index',
    'pages/dashboard/index',
    'pages/diary/index',
    'pages/weight/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#0f172a',
    navigationBarTitleText: '轻生活',
    navigationBarTextStyle: 'white',
    backgroundColor: '#0f172a',
  },
  tabBar: {
    color: '#94a3b8',
    selectedColor: '#22c55e',
    backgroundColor: '#0f172a',
    borderStyle: 'black',
    list: [
      { pagePath: 'pages/dashboard/index', text: '今日' },
      { pagePath: 'pages/diary/index', text: '饮食' },
      { pagePath: 'pages/weight/index', text: '体重' },
    ],
  },
}
