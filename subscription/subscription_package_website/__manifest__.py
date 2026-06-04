# -*- coding: utf-8 -*-
{
    'name': 'Subscription Management Website',
    'version': '18.0.0.0',
    'category': 'Subscription/Website',
    'depends': [
        'base',
        'web',
        'website',
        'subscription_package_extended'
    ],
    'data': [
        "views/home_page_template.xml",
        "views/header_template.xml",
        "views/footer_template.xml",
        "views/find_match_template.xml",
    ],
    'assets': {
        'web.assets_frontend': [
            'subscription_package_website/static/src/scss/style.scss',
            'subscription_package_website/static/src/scss/shop_theme.css',
        ],
    },
    'license': 'LGPL-3',
    'installable': True,
    'auto_install': False,
    'application': True,
}
