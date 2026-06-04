/** @odoo-module **/

import publicWidget from "@web/legacy/js/public/public_widget";

publicWidget.registry.CustomAddToCart = publicWidget.Widget.extend({
    selector: '.custom_trigger_cart',
    events: {
        'click': '_onClick',
    },
    async _onClick(ev) {
        ev.preventDefault();
        const productId = ev.currentTarget.dataset.productId;
        if (!productId) {
            console.error("No product ID found");
            return;
        }
        await fetch('/shop/cart/update_json', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                product_id: parseInt(productId),
                add_qty: 1,
            }),
        });
        window.location.href = '/shop/cart';
    },
});